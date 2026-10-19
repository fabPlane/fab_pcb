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
