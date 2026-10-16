# Autorouter benchmark

Read README.md. Run `bun run benchmark:autorouter` from the repository root.
For a new machine, read SETUP.md first. Use native setup; do not introduce Docker.
The current reference runtime is Linux x86-64. Do not claim native macOS support from Linux tests.

This is a standalone five-router benchmark. Do not call FabPCB's bridge or Fabdesk, change
frozen cases/checker to improve a score, hand-repair returned boards, or omit failed attempts.
Use `--fab-router-source` or a copied configuration directory for candidate engines.
Keep the baseline runtime and source unchanged while its run is active.

Use summary.json for task outcomes and failure pointers; open report.html for board comparisons.
Smoke/subset/incomplete runs are not full-suite scores. Inspect raw checks before drawing conclusions.
Run relevant engine tests separately when changing engine code. Do not start an LLM or improvement
loop as part of the benchmark command. Benchmark execution never publishes or merges changes.
