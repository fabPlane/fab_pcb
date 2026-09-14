# Router regression corpus

`packages/router/corpus` holds fixed `RouteInput` workloads at the router boundary. This keeps the
algorithm test independent of netlist compilation and installed footprint libraries. Each case has
an inner router deadline and runs in a separate Bun process with a hard deadline, so a solver step
that blocks its event loop cannot wedge the test runner.

```bash
bun run --filter @fp-pcb/router test:corpus
bun run --filter @fp-pcb/router test:corpus:nightly
```

The PR tier contains a small known-passing crossing case. Nightly adds fine-pitch fanout and a
coarse parallel bus. `gate` cases require termination, truthful completion and clean fast geometry
checks. `observe` cases always gate liveness but only report their known output-quality failures;
change a case to `gate` in the same PR that fixes it.

The fast validator rejects malformed output, unknown nets, tracks outside the outline, crossings,
and approximate pad/track clearance violations. It intentionally does not replace KiCad DRC. The
real-board integration suite applies router output to a temporary KiCad board, measures the
remaining ratsnest and treats KiCad DRC as the authoritative post-route result.
