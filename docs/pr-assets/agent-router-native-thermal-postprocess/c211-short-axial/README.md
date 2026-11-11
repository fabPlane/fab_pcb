# Width-scaled thermal search pin

Select engine `34f33a19c1121a2594e32147dd1ba2e2d759a78b`. Relative to old pin 4ae389a2, only the offline proposal
generator changes among src/ and tools/. The new paths supplement the existing
prefix without changing the 304-proposal stage limit or native acceptance.

Fresh matched full suite: 26 cases × 3 seeds/version: before 45/78 passes, 15/26 valid cases,
120 opens, 18 new errors; after45/78passes,15/26valid,120 opens, 18 new errors. Every
outcome, physical output inventory, DSN/session and successful repair sequence/
checkpoint geometry matches. No full-suite score or timing gain is claimed.
The standalone reduced complete-net control now publishes a valid zero-error,
109-open candidate after 97 checks, where the old search exhausted 90 proposals.
Three paired native checks/version agree; all source/current pairs and native
ownership remain intact. Its 3600-second outer budget does not establish a
repair within this adapter's unchanged 600-second cap. Full Aquarius is unresolved.

Package checks: typecheck and 109 tests pass, with 6 existing availability skips
and 416 assertions. The initial run had one additional skip because the native
search source environment variable was missing; its log is retained.

Complete raw boards/reports/rules/controls, fail-first and initial failed check
logs, source hashes, full-suite attempts, independent saved boards and exact
reproduction/replay scripts are committed in engine PR44:
https://github.com/fabPlane/fab_router/tree/agent/fab-router-native-drc-gate/docs/pr-assets/agent-fab-router-native-drc-gate/c211-short-axial

The engine implementation and measured tool hashes match exactly. Before-suite
metadata uses isolated 124b7bd8, executable-equivalent to old pin 4ae389a2;
after controls name parent 124b7bd8 because the measurement began before commit,
with exact measured hashes matched to the final implementation. No frozen case,
checker, scoring, native rule, default config or live-editor behavior changes.
