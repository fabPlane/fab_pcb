Three terminals share one net on a 30 × 10 mm two-layer board. Only the unrouted board is a router input. Partial and complete states contain one and two manually placed segments, respectively; they are diagnostic output controls, not engine results. Terminal ownership and geometry remain equal across all states. No project sidecar is needed: the fixtures use default rules with 1 mm circular pads, 10 mm spacing and 0.25 mm tracks.

Native checker 10.0.6 on hyper-ms-lin, cores 0–5, nice 10: three independent generations per state, one fresh DRC per generation, using Python optimization. All board bytes match across repeats.

| Control             | Before native opens (unrouted) | After native opens | Before / after errors | Before / after warnings | Repeats |
| ------------------- | -----------------------------: | -----------------: | --------------------- | ----------------------- | ------: |
| Unrouted            |                              2 |                  2 | 0 / 0                 | 0 / 0                   |       3 |
| One manual segment  |                              2 |                  1 | 0 / 0                 | 0 / 0                   |       3 |
| Two manual segments |                              2 |                  0 | 0 / 0                 | 0 / 0                   |       3 |

The partial state distinguishes net-count completion (0%) from the proposed initial-native-open denominator (50%). This fixture does not adopt that scoring change, alter ranking, prove pairwise repaired-edge identity, or measure an engine improvement. Production adoption still requires the combined archive, dependency, bounded-helper, both-adapter, direct-caller and cache changes.

Reproduce from repository root:

```sh
nice -n 10 taskset -c 0-5 timeout 240 /usr/bin/python3 -O benchmarks/boards/native-multiterminal/generate.py /tmp/native-control-new
nice -n 10 taskset -c 0-5 timeout 120 /usr/bin/python3 -O benchmarks/boards/native-multiterminal/test_generate.py
bun run typecheck
FAB_ROUTER_MODULE=$HOME/bench/repos/fab_router/src/api.ts bun run test:unit
```

Use a new output directory for each generation. The Python test performs fresh checks twice and compares bundled board bytes. Source/license: original deterministic MIT generator, no external design inputs. The DSN normalizes its root export filename. This directory is outside the frozen benchmark suite and does not register new scored cases.
