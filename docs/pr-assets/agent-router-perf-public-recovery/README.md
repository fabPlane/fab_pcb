# Optional local recovery pin

The router pin advances to `790256b1` (see the complete revision in
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

The latest cache pin increment and fresh 26×3 speed/quality evidence are documented in [quilt-front/README.md](quilt-front/README.md). Its dense single observation is slower, while frozen-suite route time improves; full limitations are retained there.

## Formatting maintenance (cycle 104)

The unit CI job stopped at `format:check` on this branch. Markdown tables and the
adapter regression test now follow repository formatting. Generated JSON captures
and the frozen native baseline retain their serialized bytes through scoped
`.prettierignore` entries. Manifests reflect the formatted Markdown; benchmark
values, source pin, copper, rules and chart images are unchanged.

Validation on the same host: full repository `bun run format:check` passes;
consumer typecheck and the focused suite pass (97 tests, one optional runtime
skip, 379 assertions). No routing measurement was run for this formatting change,
so the existing before/after table and its limitations still apply.

```bash
bun run format:check
python3 docs/pr-assets/agent-router-perf-public-recovery/verify-manifests.py
python3 docs/pr-assets/agent-router-perf-public-recovery/rim-composition/check-package.py --engine-source /home/hyper/bench/wt/fr-perf
```
