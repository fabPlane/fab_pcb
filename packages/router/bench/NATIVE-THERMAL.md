# Optional native thermal postprocessing

The standalone benchmark normally imports SES and checks the resulting native board.
`native-thermal-config.py` creates an alternate configuration that runs bounded thermal
search after that import and before the independent checker. The frozen configuration,
inputs, checker and scoring stay unchanged. This is an explicit candidate pipeline;
the additional native checks and search time count toward route-path time.

Use an engine checkout containing `tools/native-thermal-search.ts` and the matching
native gate/proposal helpers. The text-routing engine and native-search checkout can
be selected independently; record both revisions. Stock KiCad 10.0.6 bindings and CLI,
Bun and GNU `timeout` are required. No server or remote endpoint is used.

```sh
python3 packages/router/bench/native-thermal-config.py \
  --engine /path/to/fab_router --out /tmp/native-thermal-config
 taskset -c 20-25 nice -n 10 python3 benchmarks/autorouter/benchmark.py \
  --router fab-router --fab-router-source /path/to/fab_router \
  --config-dir /tmp/native-thermal-config --out /tmp/native-thermal-results
```

Each attempt retains `work/native-thermal-postprocess/`: command stdout/stderr,
`postprocess.json`, all generated proposals, checked reports and any accepted bundle.
The search has a ten-minute process-group timeout with a five-second kill grace.
`rejected` and `search-failed` results retain the original router output and their
exit code. They do not make that board valid: the unchanged independent checker
still scores it. Tool launch, handoff integrity and publication failures propagate.
Inspect these statuses alongside the benchmark summary; a fallback is never a
successful repair.

Only a fully accepted local repair bundle can replace the disposable routed board.
The handoff checks board hashes, source and current routed snapshots, source and
routed terminal-pair preservation, and exact native sidecars. It stages checked board
bytes beside the output and renames that one file atomically. It does not rewrite
rule files or source inputs. It assumes exclusive ownership of the disposable board
and its directory throughout the run. It provides no live-editor transaction,
concurrent-writer protection, signed attestation or power-loss durability guarantee.
The benchmark's independent checks remain authoritative.

Current search limitation: scoped native import can assign fresh UUIDs to retained
tracks. A UUID-only proposal exclusion can then select authored copper; the strict
source-copper validator refuses the proposal and the search is recorded as failed.
The postprocessor keeps the original board for independent scoring. A search tool
revision that identifies retained copper by physical inventory is needed to remove
this blocker; do not weaken the source-copper check.
