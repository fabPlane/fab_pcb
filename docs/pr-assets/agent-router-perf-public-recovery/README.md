# Optional local recovery pin

The router pin advances to `5be94a06` (see the complete revision in
`packages/router/FAB_ROUTER_COMMIT`), dependent on the engine change in
https://github.com/fabPlane/fab_router/pull/37. The adapter accepts explicit
`extra: { localRecovery: true }` and rejects non-boolean values. Omitted and false
values preserve opt-out. Existing cancellation and progress hooks flow through.

The attached full native benchmark measures the actual public engine API with
its setting off/on, using the same 26 frozen cases and three seeds. It does not
measure this adapter's DSN exporter. Its native gains therefore establish the
pinned engine behavior, not a separate adapter benchmark gain. Per-case table,
all paired records and chart are retained here. The normal public API outputs
match all 78 prior control sessions/quality; default behavior remains unchanged.

Typecheck passes. With the pinned engine content explicitly selected, package
unit tests pass: 97 pass, one optional runtime test skipped, zero failures. The
full package test invocation additionally attempts native editor integration;
that editor exited before its local IPC listener became available. Its failure
and the initial missing-engine corpus failure are retained in package-checks.log.txt.
Selecting FAB_ROUTER_MODULE resolves the corpus test; native editor integration
is still unvalidated. No test expectations or integration gating were changed.

```bash
bun install --frozen-lockfile --ignore-scripts
bun run --cwd packages/router typecheck
cd packages/router
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-perf/src/api.ts bun test $(rg --files test -g '*.test.ts' -g '!router.kicad.test.ts')
```

The engine setting is experimental and off by default. Existing 27 native
thermal errors remain unresolved. Large-input and full slow acceptance evidence
is tracked on the engine PR; enabling recovery by default needs further review.
