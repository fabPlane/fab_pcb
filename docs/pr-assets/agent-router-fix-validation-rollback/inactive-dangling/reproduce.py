#!/usr/bin/env python3
"""Repeat stateful adapter diagnostics; restores candidate source even on failure."""
import os, subprocess
from pathlib import Path
root = Path(__file__).resolve().parents[4]
source = root / "packages/router/src/bridge-job.ts"
candidate = source.read_bytes()
output = Path(os.environ.get("AUDIT_OUT", "/tmp/inactive-dangling-audit"))
output.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, FAB_ROUTER_MODULE=os.environ.get("FAB_ROUTER_MODULE", str(Path.home() / "bench/wt/fr-bugs/src/api.ts")))
try:
    for version in ("before", "after"):
        source.write_bytes(subprocess.check_output(["git", "show", "4647d1e:packages/router/src/bridge-job.ts"], cwd=root) if version == "before" else candidate)
        for repeat in range(1, 4):
            run = subprocess.run(["taskset", "-c", "20-25", "nice", "-n", "10", "timeout", "120", "bun", "test", "packages/router/test/bridge-validation.test.ts"], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            (output / f"{version}-{repeat}.log").write_bytes(run.stdout)
            assert run.returncode == (1 if version == "before" else 0), (version, repeat, run.returncode)
            assert (b"35 pass" in run.stdout and b"3 fail" in run.stdout) if version == "before" else (b"38 pass" in run.stdout and b"0 fail" in run.stdout)
finally:
    source.write_bytes(candidate)
print("Three repeats: inactive-copper preservation 0/9 before, 9/9 after; prior controls 99/99 and active controls 6/6 both.")
