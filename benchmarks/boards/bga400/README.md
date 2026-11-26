# Eight-layer BGA400 candidate

Original MIT synthetic fixture, seed 6408. Regenerate with:

```sh
/usr/bin/python3 -O benchmarks/boards/bga400/generate.py /tmp/bga400-new --seed 6408
bun run typecheck
/usr/bin/python3 -O benchmarks/boards/bga400/test_generate.py
FAB_ROUTER_MODULE=$HOME/bench/repos/fab_router/src/api.ts bun run test:unit
```

The destination must not exist. Requires the native `pcbnew` Python module and
`kicad-cli`. The generator checks a freshly loaded board, project rules, copper
stack, two terminals per net, absence of tracks/zones, and fresh native DRC.
It exports DSN and normalizes only the DSN root filename. Board, companion
project and DSN bytes reproduce across destination directories.

| Parameter                          |                                      Value |
| ---------------------------------- | -----------------------------------------: |
| Board                              |                                 60 × 60 mm |
| Signal copper layers               |                                          8 |
| BGA                                | 20 × 20, 0.65 mm pitch, 0.30 mm round pads |
| Destination terminals              |        400, shuffled by seed, 0.40 mm pads |
| Nets / pads / native opens         |                            400 / 800 / 400 |
| Track / clearance                  |                             0.10 / 0.10 mm |
| Through via diameter / drill       |                             0.30 / 0.10 mm |
| Native input DRC errors / warnings |                                      0 / 0 |

The companion `.kicad_pro` is part of the fixture and must travel with the board.
All copper layers are signal layers. There are no planes, pair constraints,
length groups, or external footprint libraries. The destinations form four
2 × 50 terminal banks. The permutation intentionally introduces crossings.

This expands the six-layer candidate's 324-ball, 0.8 mm BGA coverage to 400
balls at 0.65 mm pitch and 400 nets. The boards have different topology and
layer counts; routing difficulty is not established by this geometry alone.
In particular, native input admission does not establish routed feasibility or
an improvement in any engine. Production scoring and frozen fixtures are unchanged.

This candidate is outside the frozen autorouter suite. It is not registered in
that suite and does not change historical scores.
