# SPDX-License-Identifier: MIT
"""Validate bundled/regenerated dense6 inputs against the pinned manifest."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import pcbnew

ROOT = Path(__file__).resolve().parent


def validate(source, hashes):
    if (source / 'dense6-bga324.kicad_dru').exists():
        raise ValueError('unexpected custom rule sidecar')
    for name, expected in hashes.items():
        if hashlib.sha256((source / name).read_bytes()).hexdigest() != expected:
            raise ValueError(f'fixture identity mismatch: {name}')
    board = pcbnew.LoadBoard(str(source / 'dense6-bga324.kicad_pcb'))
    pads = [pad for footprint in board.GetFootprints() for pad in footprint.Pads()]
    nets = {pad.GetNetname() for pad in pads if pad.GetNetname()}
    if (board.GetCopperLayerCount() != 6 or len(pads) != 702 or len(nets) != 263
            or list(board.GetTracks()) or board.GetAreaCount()):
        raise ValueError('unexpected dense6 geometry or existing routing')

    return sorted((fp.GetReference(), pad.GetNumber(), pad.GetNetname(),
                   pad.GetPosition().x, pad.GetPosition().y,
                   pad.GetSize().x, pad.GetSize().y, int(pad.GetShape()),
                   int(pad.GetAttribute()), tuple(pad.GetLayerSet().CuStack()))
                  for fp in board.GetFootprints() for pad in fp.Pads())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    with tempfile.TemporaryDirectory(prefix='dense6-regenerate-') as temp:
        subprocess.run([sys.executable, str(ROOT / 'generate.py'), temp], check=True, timeout=30)
        reference = validate(ROOT, manifest['sha256'])
        for label, source in [('bundled', ROOT), ('regenerated', Path(temp))]:
            hashes = manifest['sha256'] if label == 'bundled' else manifest['generated_sha256']
            if validate(source, hashes) != reference:
                raise ValueError('regenerated pad geometry differs')
            subprocess.run([sys.executable, str(ROOT / 'tools/measure.py'), '--out',
                            str(args.out.resolve() / label), '--dense',
                            str(source / 'dense6-bga324.kicad_pcb'), '--repeats', '3'],
                           check=True, timeout=1800)
