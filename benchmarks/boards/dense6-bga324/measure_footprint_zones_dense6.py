#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Measure fixed-candidate footprint-zone admission; no routing is performed."""
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
    for reference in (None, 'J1', 'J2', 'U1'):
        case = 'valid' if reference is None else 'footprint-zone-' + reference
        fixture = args.out / f'{case}-{repeat}'
        shutil.copytree(args.fixture, fixture)
        if reference is not None:
            path = fixture / 'dense6-bga324.kicad_pcb'
            board = pcbnew.LoadBoard(str(path))
            footprint = next(f for f in board.GetFootprints() if f.GetReference() == reference)
            zone = pcbnew.ZONE(footprint)
            zone.SetIsRuleArea(True)
            zone.SetLayer(pcbnew.F_Cu)
            zone.SetDoNotAllowTracks(True)
            zone.SetDoNotAllowVias(True)
            # An empty board corner avoids pre-existing pads; the rule still
            # changes where future routed tracks and vias are allowed.
            zone.Outline().NewOutline()
            for x, y in ((1, 1), (2, 1), (2, 2), (1, 2)):
                zone.Outline().Append(pcbnew.FromMM(x), pcbnew.FromMM(y))
            footprint.Add(zone)
            if len(footprint.Zones()) != 1 or len(board.Zones()) != 0:
                raise RuntimeError('mutation did not create a footprint-only zone')
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
            if not expected and 'unsupported native footprint zones' not in result.stderr:
                raise RuntimeError(result.stderr)
            records.append(dict(repeat=repeat, case=case, version=version,
                                accepted=result.returncode == 0, wall_s=time.monotonic() - start))
            (args.out / 'controls.json').write_text(json.dumps(records, indent=2) + '\n')
print('Unchanged accepted 3/3 -> 3/3; altered footprint zones accepted 9/9 -> 0/9')
