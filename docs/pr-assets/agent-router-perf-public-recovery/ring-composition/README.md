# Exact containment pin evidence

Pin increment: `790256b1358406c2c2e9c16788f7586cd7ad4808` → `b65bcf03945ca2aa9704b2e196e089f0aaa60a8d`. The old pin is source-identical to the native control `ff199fea`; the new pin matches the measured candidate implementation/spec/test/tool/config hashes. This increment changes only the production ring predicate and adds its differential test. Recovery remains off by default.

Consumer package typecheck passes; 97 unit tests pass, 1 optional runtime test skips, 0 fail. The engine production gate passes 913 tests/607699 assertions, zero layer violations. Enabled slow acceptance retains 51 passes/12 existing failures/14 advisory/0 stubs, but a strict 300-second case has 19 incompletes versus 18 in its historical source-matched control. Three fresh alternating isolated pairs then match 18/18 each; the historical difference remains unexplained and is retained. Native editor integration is excluded from this package gate and remains unvalidated.

| Full native metric (26 cases × 3 repeats) | Cache control | Cache plus ring |
|---|---:|---:|
| Passed / 78 | 48 | 48 |
| Valid cases / 26 | 16 | 16 |
| Opens | 90 | 90 |
| New native errors (known, unresolved) | 27 | 27 |
| Median route seconds | 1.120513 | 1.121454 |
| p95 route seconds | 17.460792 | 15.183399 |
| Sum route seconds | 412.713731 | 399.145318 |
| Sweep wall seconds | 524.490916 | 511.169069 |
| Sum case medians seconds | 136.943229 | 129.281443 |
| Sum case p95 seconds | 142.296661 | 144.455887 |
| Sum vias | 2826 | 2826 |
| Sum length mm | 60450.378202 | 60450.378202 |

The source-override native benchmark measures its standalone export/import and exported engine API, rather than this package exporter or live editor. Total route time falls 3.29% and p95 falls 13.04%; overall median rises 0.08%, summed case p95 rises 1.52%, dense median regresses 2.56%, and ladder timings regress about 0.8%. Shared-host timing is observational. All 78 paired native sessions/stats/reports except wall match; 27 known router-introduced thermal errors remain unresolved. The latest cache-only warmed replay regressed 9%; these incremental ring results do not establish a standalone cache benefit.

[Engine review and complete raw evidence](https://github.com/fabPlane/fab_router/pull/37) includes all 156 native attempts, six fresh strict-budget checks, three dense pairs, two ladder pairs, slow acceptance, source inventories, profiles, corruption controls and exact commands.

Exact reproduction, with installed dependencies and the private native benchmark runtime already prepared:

```bash
ENGINE=/home/hyper/bench/wt/fr-perf
ASSET="$ENGINE/docs/pr-assets/agent-fab-router-perf-local-rescue/ring-composition"
RUN=/home/hyper/bench/agents/codex-fabpcb-perf/scratch/ring-composition-pin-repro
python3 "$ASSET/prepare-repro.py" "$ENGINE" "$RUN" ff199fea b65bcf03945ca2aa9704b2e196e089f0aaa60a8d
python3 "$RUN/native.py"
cd /home/hyper/bench/wt/fp-perf/packages/router
bun run typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-perf/src/api.ts bun test $(rg --files test -g '*.test.ts' -g '!router.kicad.test.ts')
```

[Full engine evidence, all native attempts, source verification, profile and stress details](https://github.com/fabPlane/fab_router/blob/agent/fab-router-perf-local-rescue/docs/pr-assets/agent-fab-router-perf-local-rescue/ring-composition/README.md). No frozen fixture, native rule, checker or scoring changes. Native editor integration remains unvalidated.
