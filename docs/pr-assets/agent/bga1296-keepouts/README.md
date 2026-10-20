# BGA1296 keepout qualification

A deterministic MIT eight-layer input with 1,296 two-terminal nets, 2,592 pads,
0.5 mm BGA pitch and two 3 × 28 mm all-copper routing keepouts. This is an
unrouted candidate. There is no complete DRC-clean reference solution.

Paired input qualification on the same host, three fresh native checks per
variant; seed, terminal placement, ownership and project rules are identical.
Only the two routing keepouts differ. Native geometry checks pass in every run.

| Measurement | Before: no keepouts | After: two keepouts | Repeats each |
|---|---:|---:|---:|
| Native connectivity opens | 1296 | 1296 | 3 |
| Native geometry errors / warnings | 0 / 0 | 0 / 0 | 3 |
| DSN keepout polygons | 0 | 16 | 3 |
| Identical terminal signature / project digest | yes | yes | 3 |

The JSON DRC lists 499 opens in each variant because of the checker limit.
It is not used as the exact native denominator. Qualification does not establish
routed feasibility, router gain or native baseline adoption. Full routing
measurement is retained in [MEASUREMENT.md](MEASUREMENT.md).

```sh
nice -n 10 taskset -c 0-5 timeout 180 /usr/bin/python3 -O docs/pr-assets/agent/bga1296-keepouts/qualify.py /tmp/bga1296-qualification
nice -n 10 taskset -c 0-5 timeout 180 /usr/bin/python3 -O -m unittest discover -s benchmarks/boards/bga1296 -p 'test_*.py'
bun run typecheck
FAB_ROUTER_MODULE=$HOME/bench/repos/fab_router/src/api.ts bun run test:unit
```

`qualification.json` retains per-repeat digests and observations. `render.py`
draws native pad positions and the routing keepouts. The fixture includes only
original synthetic data and the generator; no frozen benchmark files change.
