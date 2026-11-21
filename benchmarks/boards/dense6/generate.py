# SPDX-License-Identifier: MIT
"""Reproduce the MIT dense6 seed-6406 board and preserve its source rules."""
import argparse
import json
from pathlib import Path
import shutil
from gen_dense6 import build, write_pcb, stats

ROOT = Path(__file__).resolve().parent
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if (args.out / 'dense6-bga324.kicad_dru').exists():
        raise ValueError('output contains an unexpected custom rule sidecar')
    fps, nets, uid = build(6406)
    write_pcb(args.out / 'dense6-bga324.kicad_pcb', fps, nets, uid)
    shutil.copyfile(ROOT / 'dense6-bga324.kicad_pro', args.out / 'dense6-bga324.kicad_pro')
    (args.out / 'stats.json').write_text(json.dumps(stats(fps, nets), indent=2) + '\n')
