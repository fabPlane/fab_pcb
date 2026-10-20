"""Verify local evidence manifests without changing recorded benchmark captures."""

import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
checked = 0


def verify(directory, records):
    global checked
    for name, record in records.items():
        path = directory / name
        if isinstance(record, dict) and "sha256" not in record:
            verify(directory, record)
            continue
        digest = record.get("sha256") if isinstance(record, dict) else record
        if not isinstance(digest, str) or len(digest) != 64:
            continue
        if not path.is_file():
            raise ValueError(f"Missing manifest member: {path}")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError(f"Checksum: {path}")
        if isinstance(record, dict) and "bytes" in record:
            if len(data) != record["bytes"]:
                raise ValueError(f"Size: {path}")
        checked += 1


for manifest in sorted(root.rglob("manifest.json")):
    verify(manifest.parent, json.loads(manifest.read_text()))
board = root.parents[2] / "benchmarks/boards/dense6-local-recovery"
verify(board, json.loads((board / "inputs.sha256.json").read_text())["inputs"])
print(f"Verified {checked} evidence and frozen input checksums")
