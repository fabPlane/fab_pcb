Advance the engine pin to 8fa7ead0c45b0e7ca33737ff418f6309d51d762c, preserving authored footprint coordinates finer than the routing lattice. The engine PR contains seven regressions and complete native evidence.

Same host, 26 fixed cases × three repeats per phase: native passes 39/78 → 39/78; cases valid 3/3 13/26 → 13/26; opens 120 → 120; new thermal errors 27 → 27. Exact source-pad preservation 66/78 → 78/78; moved footprint instances 39 → 0; moved pad instances 291 → 0. All 78 generated route scopes and individual outcomes match.

Package typecheck passes; tests: 96 pass, 6 existing availability skips, 0 fail. The final run selects the candidate via FAB_ROUTER_MODULE and removes an unsupported API-server CLI override, allowing the existing availability gate to recognize that the live API service is absent. The initial setup failures and final logs are both retained. No tests were edited. Native benchmark execution uses the stock checker independently of that API service.

Reproduce package checks:

```bash
cd ~/bench/wt/fp-bugs
env -u KICAD_CLI FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts bun run --cwd packages/router typecheck
env -u KICAD_CLI FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts bun run --cwd packages/router test
```

Reproduce complete native runs with the existing benchmark setup:

```bash
cd ~/bench/wt/fp-bugs
taskset -c 20-25 nice -n 10 python3 benchmarks/autorouter/benchmark.py --router fab-router --fab-router-source ~/bench/agents/codex-fabpcb-bugs/scratch/c196/before-source --out ~/bench/agents/codex-fabpcb-bugs/scratch/c196/repro-before
taskset -c 20-25 nice -n 10 python3 benchmarks/autorouter/benchmark.py --router fab-router --fab-router-source ~/bench/wt/fr-bugs --out ~/bench/agents/codex-fabpcb-bugs/scratch/c196/repro-after
```

The before checkout is 69cf598db98c136bff16bbe02bccdded95674b18. Candidate source hashes match the implementation commit. Full reports, native boards, licenses, minimal probes and archive replay scripts are available under the engine evidence path linked in the PR. The existing thermal failures remain unresolved.
