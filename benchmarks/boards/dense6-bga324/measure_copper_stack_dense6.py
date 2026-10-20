#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Measure fixed-candidate copper-stack admission; no routing is performed."""
from pathlib import Path
import argparse
import json
import shutil
import subprocess
import time
import pcbnew

parser = argparse.ArgumentParser(description=__doc__)
for name in ('before', 'after', 'generator', 'fixture', 'out'):
    parser.add_argument('--' + name, required=True, type=Path)
args = parser.parse_args()
for name in vars(args):
    setattr(args, name, getattr(args, name).resolve())
args.out.mkdir(parents=True, exist_ok=False)
records = []
for repeat in range(1, 4):
    for reference in (None, 'name', 'power', 'mixed'):
        case = 'valid' if reference is None else 'copper-stack-' + reference
        fixture = args.out / f'{case}-{repeat}'
        shutil.copytree(args.fixture, fixture)
        if reference is not None:
            path = fixture / 'dense6-bga324.kicad_pcb'
            board = pcbnew.LoadBoard(str(path))
            layer = pcbnew.In1_Cu
            if reference == 'name':
                board.SetLayerName(layer, 'Plane1')
            else:
                board.SetLayerType(layer, pcbnew.LT_POWER if reference == 'power' else pcbnew.LT_MIXED)
            if board.GetCopperLayerCount() != 6:
                raise RuntimeError('mutation changed layer count')
            pcbnew.SaveBoard(str(path), board)
            # Saving can reserialize project settings; preserve the original policy.
            shutil.copyfile(args.fixture / path.with_suffix('.kicad_pro').name,
                            path.with_suffix('.kicad_pro'))
        for version, script in (('before', args.before), ('after', args.after)):
            start = time.monotonic()
            output = args.out / f'{version}-{case}-{repeat}'
            result = subprocess.run(['/usr/bin/python3', '-O', str(script),
                                     '--generator', str(args.generator), '--fixture', str(fixture),
                                     '--out', str(output)], capture_output=True, text=True, timeout=180)
            (args.out / f'{version}-{case}-{repeat}.log').write_text(result.stdout + result.stderr)
            expected = version == 'before' or reference is None
            if (result.returncode == 0) != expected:
                raise RuntimeError(f'{version} {case}: {result.stderr}')
            if not expected and 'generated geometry differs' not in result.stderr:
                raise RuntimeError(result.stderr)
            records.append(dict(repeat=repeat, case=case, version=version,
                                accepted=result.returncode == 0, wall_s=time.monotonic() - start))
            (args.out / 'controls.json').write_text(json.dumps(records, indent=2) + '\n')
print('Unchanged accepted 3/3 -> 3/3; altered copper stack accepted 9/9 -> 0/9')
