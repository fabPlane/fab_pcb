# Owned command lifecycle measurement

The production command wrapper now resolves the direct child's exit before
waiting for inherited output pipes. It owns a POSIX process group, stops that
group on every exit path, removes abort listeners and timers, and bounds final
pipe draining to 100 ms. Timeout defaults and cancellation use immediate SIGKILL. An explicit
`killSignal` is validated before spawn and gets at most 100 ms before SIGKILL;
the escalation timer is cleared on direct-child exit. The session wrapper
continues using the immediate default. Windows stops the direct child only.
A deliberately detached descendant is outside group cleanup. Its pipe cannot
block return, and trailing output beyond the final drain can be truncated.
A callback failure rejects after cleanup. Nonzero parent exits remain nonzero.

These are deliberately constructed wrappers, not observed engine failures.
Each exit mode has three before/after repeats on hyper-ms-lin, cores 0–5,
nice 10, with the same 250 ms deadline and child workload. Children surviving
the invocation fall from 9/9 to 0/9; six false timeouts fall to zero. Real engine
sessions separately retain 100% completion, zero opens, zero native errors,
and two native warnings across three before/after pairs. This canary has one
net; no routing-speed or general board-quality improvement is claimed.

The small synthetic MIT fixture is an unrouted two-resistor canary. The PCB
and native-exported DSN are bundled so reproduction needs no external board.
Only summaries and digests are published. `provenance.json` records the runtime
observation and input/session/report hashes; it is not a cache-acceptance token.

From the repository root (Bun, Java, native checker/Python bindings and
rsvg-convert installed), with FREEROUTING_JAR set to the local pinned JAR:

```sh
git show 12b7edb2047e7c4e2710167419f5781899281303:packages/router/src/freerouting.ts > packages/router/src/lifecycle-before.ts
nice -n 10 taskset -c 0-5 timeout 180 bun benchmarks/tools/command-lifecycle/measure.ts session packages/router/src/lifecycle-before.ts packages/router/src/freerouting.ts /tmp/owned-command-measure benchmarks/tools/command-lifecycle/fixture/unrouted.dsn
nice -n 10 taskset -c 0-5 timeout 180 /usr/bin/python3 benchmarks/tools/command-lifecycle/verify_native.py --pcb benchmarks/tools/command-lifecycle/fixture/unrouted.kicad_pcb --measure /tmp/owned-command-measure
```

Use a fresh measurement directory. `controls.json` contains all 18 constructed
invocations; `native.json` retains six real session paths. The native verifier
imports every saved session into the original board, restores rule sidecars,
and runs a fresh native DRC before comparing before/after counts. An outer
timeout bounds the verifier's native module load. Existing scoring rules remain.
`plot.py` reads the committed controls CSV and produces the review PNG.

## Custom signal compatibility

Cycle 35 adds the integration branch's numeric `killSignal` option without
removing group ownership, parent-exit precedence, or bounded pipe draining.
A requested signal can run a shutdown handler; ignored or nonterminating
signals still reach forced cleanup. Invalid signals reject before spawn.
Cancellation and callback failures still stop immediately. Signal numbers
follow the local operating system; the measurements use POSIX SIGTERM (15).
Timeout output can be truncated as before, including shutdown diagnostics.

On the same host, three paired constructed cases per mode give:

| Case | Before | After |
|---|---:|---:|
| Requested handler ran | 0/3 | 3/3 |
| Ignored signal left a descendant alive | 0/3 | 0/3 |
| Invalid signal launched a command | 3/3 | 0/3 |

These were constructed API counterexamples, not observed routing failures.
The existing integration API already handles the three modes correctly; the
purpose is preserving that behavior while adopting parent-exit precedence.
Three paired real reroutes per repository preserve native one-net quality;
this does not establish general board parity or a routing speed gain.

Reproduce with fresh output paths and the previous helper saved from
`f6f4d66` (private) or `e657a13` (public):

```sh
bun measure_signals.ts /absolute/path/before-owned.ts /absolute/path/after-owned.ts /tmp/fresh-signal-controls
python3 plot_signals.py /absolute/path/signals.csv /tmp/signals.png
```

Run these tools from their directory. The CSV is a faithful flattening of
`signals.json`, with the union of its fields and booleans retained as booleans.
