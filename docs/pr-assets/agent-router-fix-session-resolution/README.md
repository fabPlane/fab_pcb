Reject malformed SES resolutions before importing copper. Unknown units previously fell back to micrometres (or inherited object properties), zero/NaN counts fell back to one, negative counts mirrored coordinates, and non-finite scales collapsed or corrupted geometry. The parser now requires a known own-property unit and a positive finite count and resulting scale. Omitted resolution retains its existing default.

Regression tests exercise both route declarations and placement fallback, plus all five supported units and the omitted-resolution default. No board mutation, native checker, engine, or routing policy changes.

Same host `hyper-ms-lin`, cores 20–25, identical 20-case parser workload, three repeats per revision:

| Regression benchmark | Before 12b7edb (each repeat) | After (each repeat) |
|---|---:|---:|
| Invalid resolutions rejected | 0/14 | 14/14 |
| Valid geometry/default controls | 6/6 | 6/6 |
| Total | 6 pass / 14 fail | 20 pass / 0 fail |

This measures parser correctness, not routing completion or speed. No new native router benchmark was run. Latest full fab_router context remains 39/78 passes, 13/26 cases valid in all three repeats, 120 opens and 27 thermal errors; those P0 errors remain unresolved. Native routing non-regression has not been established for this adapter change.

Validation: adapter typecheck passes; configured package unit suite passes 116 tests, one existing jar-dependent skip, zero failures (406 assertions). The 20 added regressions run in the existing SES test file. Raw before/after logs, source hashes and chart are committed beside this document.

Reproduce from repository root:

```sh
for repeat in 1 2 3; do
  taskset -c 20-25 timeout 60 bun test packages/router/test/specctra.test.ts -t 'session resolution'
done
bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 600 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
```

For before, apply only the test-file diff to base 12b7edb, leaving `ses.ts` unchanged, then run the same targeted command. No external service is needed. Unsupported unit names now throw `SyntaxError`; callers that relied on silently treating an unknown unit as micrometres must supply a supported unit.

![Repeated session resolution regression results](https://github.com/fabPlane/fab_pcb/blob/agent/router-fix-session-resolution/docs/pr-assets/agent-router-fix-session-resolution/comparison.png?raw=true)


Wire path validation follow-up (cycle 145): malformed paths previously yielded NaN, unsafe coordinates, nonpositive widths, or silently dropped coordinates. Require a positive width after rounding, safe integer nanometre dimensions, and at least two complete coordinate pairs; reject nested path operands. Signed fractional coordinates remain supported.

Same host/cores, identical 11-case workload, three repeats each, before 5cdd2ae:

| Path regression benchmark | Before, each repeat | After, each repeat |
|---|---:|---:|
| Malformed paths rejected | 0/10 | 10/10 |
| Valid fractional geometry | 1/1 | 1/1 |
| Total | 1 pass / 10 fail | 11 pass / 0 fail |

Reproduce: `taskset -c 20-25 timeout 60 bun test packages/router/test/specctra.test.ts -t 'session path'` (repeat three times). For before, apply the added tests to 5cdd2ae without the parser change. Run the same typecheck and configured package unit command above. Final package validation: 127 pass, one existing jar-dependent skip, zero failures. Raw logs and source hashes are in `c145-paths/`. No native routing measurement or improvement claim; the historical full routing summary above remains unchanged.

![Wire path regression results](https://github.com/fabPlane/fab_pcb/blob/agent/router-fix-session-resolution/docs/pr-assets/agent-router-fix-session-resolution/c145-paths/comparison.png?raw=true)
