# Runtime endpoint observations

Capture explicitly named local executables and source repositories before a
benchmark; verify the same targets afterwards. This utility is opt-in and is
not wired into the frozen autorouter benchmark, scoring or caches.

```sh
python3 benchmarks/tools/runtime-evidence/snapshot.py capture /tmp/runtime.json \
  --file checker=/usr/bin/kicad-cli --repo engine="$HOME/bench/repos/fab_router"
python3 benchmarks/tools/runtime-evidence/snapshot.py verify /tmp/runtime.json
python3 -m unittest discover -s benchmarks/tools/runtime-evidence -p 'test_*.py' -v
python3 benchmarks/tools/runtime-evidence/measure.py /tmp/runtime-controls
```

Records SHA-256 bytes, resolved paths, permission bits, repository HEAD and all
tracked source files. Rejects tracked dirty state and overwriting a startup
snapshot. Supply known tools/source files only; never supply credential files or
repositories containing tracked secrets. No environment discovery or services.

The constructed measurement applies four persistent changes before the midway
observation (bytes, permissions, launcher target, committed source), three repeats
each. Midway/end equality accepts all twelve; startup/end rejects all twelve.
Three unchanged controls remain accepted in both. These are constructed controls,
not observed router failures or a routing performance improvement.

Matching endpoints do not prove continuous immutability: changed then restored
files can escape detection. Untracked/ignored files, transitive dependencies,
imported system modules, shared libraries and interpreter startup configuration
are outside the explicit inventory. This is not an atomic snapshot or a cache key.
The local replay in the companion corpus repository uses an EXIT trap to verify
after either success or failure. This utility intentionally leaves that policy
to each caller.

## Repeat identity guard

`repeat_identity.single_identity(values, label)` requires a nonempty collection
of JSON identities to contain exactly one identity. Call it separately on each
repeat group before comparing batches. Comparing sets alone accepts two batches
that contain the same mixture of inputs or machine identities. Object key order
is ignored; invalid JSON numbers are rejected. This utility does not replace
the frozen autorouter checker, score results, or enable native baseline adoption.

```sh
python3 -m unittest discover -s benchmarks/tools/runtime-evidence -p 'test_*.py' -v
python3 benchmarks/tools/runtime-evidence/measure_repeat_identity.py /tmp/repeat-identity-controls
```

The constructed comparison has three repeats for each of three mixed-identity
controls and three unchanged controls. Equal-set comparison accepts all nine
mixed controls; the guard rejects all nine and retains all three unchanged
controls. These are deliberate counterexamples, not observed router failures.

## Batch identity guard

`batch_identities(runs)` requires one `system.cpu_name` across the entire batch
and one full `fixture` identity per `fixture.id` across all backends. Distinct
fixture IDs may describe distinct boards. Per-backend repeat checks alone allow
uniform groups that collectively compare different inputs or machines. Call this
guard before summarizing a batch; repeat counts, sample keys, backend versions
and before/after comparison remain the caller's responsibility.

```sh
python3 benchmarks/tools/runtime-evidence/measure_batch_identity.py /tmp/batch-identity-controls
```

Three deliberately mismatched batches per field (fixture hash, fixture tier,
CPU) pass per-backend admission but fail batch admission: 9 accepted before,
0 after. Three unchanged batches remain accepted. Every batch has three backends
with three repeats each. This is an opt-in evidence utility; frozen suite,
adapters, ranking and caches are unchanged. No routing gain is claimed.

The CPU field is a model/name string, not a physical-host identifier. Matching
names cannot establish that runs used the same physical machine. Run provenance
records the host separately; these constructed controls only exercise the stored
fixture and CPU fields.

The opt-in `quality_values(run)` guard validates completed `native-drc` and
`srj-scored` numeric evidence before a caller aggregates it. Completion must be a
finite number in [0, 1]; opens and errors must be nonnegative integers. Booleans
reject. Failed/unavailable quality is diagnostic and remains excluded by the
caller. This utility is outside the frozen benchmark and does not change its
scoring, caches, router adapters or ranking. Use
`python3 benchmarks/tools/runtime-evidence/measure_quality_values.py NEW_OUTPUT`
for three-repeat constructed controls and a PNG. This measures numeric admission,
not routing performance.
