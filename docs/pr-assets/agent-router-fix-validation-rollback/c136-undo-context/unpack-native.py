#!/usr/bin/env python3
"""Extract only the fixed native comparison files into a fresh directory."""
import argparse
import gzip
from pathlib import Path
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("out", type=Path)
args = parser.parse_args()
args.out.mkdir(exist_ok=False, parents=True)
for label in ("before", "after"):
    for name in ("results.json", "summary.json", "controls.json", "configs/fab-router.json"):
        source = Path(__file__).resolve().parent / f"native-{label}" / (name + ".gz")
        target = args.out / label / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(gzip.decompress(source.read_bytes()))
