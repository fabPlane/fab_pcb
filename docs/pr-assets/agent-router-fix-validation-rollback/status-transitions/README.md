# Native finding status transitions

Production code is unchanged from 6c0677c. Four new stateful controls cover baseline warnings and excluded errors becoming active errors at identical geometry, with and without zone refill. All 51 focused tests pass in each of three repeats on cores 20–25 of the same host. Temporarily counting inactive baseline findings makes exactly these four regressions fail (47 pass / 4 fail); production source was restored. Adapter unit suite: 151 pass, one existing runtime skip, zero failures. These are mock adapter diagnostics, not native benchmark or live transaction proof. No routing score or performance improvement is claimed. Safe restoration across committed native refill remains unresolved.

Reproduce from repository root:

```sh
for repeat in 1 2 3; do taskset -c 20-25 nice -n 10 timeout 60 bun test packages/router/test/bridge-validation.test.ts; done
cd packages/router
bun run typecheck
FAB_ROUTER_MODULE=$HOME/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 600 bun test $(rg --files test -g '*.test.ts' | rg -v 'router.kicad.test.ts$')
```

Sensitivity check: temporarily replace `for (const marker of before.filter(active))` with `for (const marker of before)` in bridge-job.ts, run the focused command, then restore the source. This intentionally broken mutation is never shipped.
