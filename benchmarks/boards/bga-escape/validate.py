# SPDX-License-Identifier: MIT
"""Validate deterministic native/SRJ geometry and repeated native input DRC.

Requires KiCad's pcbnew Python module and kicad-cli on PATH. Raw reports and
compact summary.csv go to --out. --reference optionally checks an earlier
fixture directory with the same B1/B2 layout; it is never modified.
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

import pcbnew

from report_audit import validate_report

ROOT = Path(__file__).resolve().parent


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def geometry(source, spec):
    tier = spec['tier']
    board = pcbnew.LoadBoard(str(source / tier / f'{tier}.kicad_pcb'))
    srj = json.loads((source / tier / 'unrouted.srj.json').read_text())
    require(set(srj) == {'layerCount', 'minTraceWidth', 'obstacles', 'connections', 'bounds'},
            'unexpected SRJ fields: routing and unvalidated constraints are not allowed')
    require(board.GetCopperLayerCount() == 4, 'expected four copper layers')
    require(not list(board.GetTracks()) and board.GetAreaCount() == 0, 'input must be unrouted and have no zones')
    pads = {}
    expected_pads = {}
    for footprint in board.GetFootprints():
        for pad in footprint.Pads():
            require(list(pad.GetLayerSet().CuStack()) == [pcbnew.F_Cu] and pad.GetAttribute() == pcbnew.PAD_ATTRIB_SMD, 'all pads must be front-side SMD')
            position, size = pad.GetPosition(), pad.GetSize()
            value = tuple(round(pcbnew.ToMM(v), 6) for v in [position.x, position.y, size.x, size.y])
            pads.setdefault(pad.GetNetname(), []).append(value)
            expected_pads[(footprint.GetReference(), pad.GetNumber())] = (pad.GetNetname(), *value[:2])
    names = {f'N{n}' for n in range(1, 101)}
    require(set(pads) == names and all(len(values) == 2 for values in pads.values()), 'expected 100 two-terminal nets')
    require(srj['layerCount'] == 4 and srj['minTraceWidth'] == .15, 'unexpected SRJ rules')
    require(srj['bounds'] == dict(minX=0, maxX=50, minY=0, maxY=50), 'unexpected bounds')
    require(len(srj['connections']) == 100 and {c['name'] for c in srj['connections']} == names, 'unexpected connections')
    require(len(srj['obstacles']) == 200, 'expected 200 obstacles')
    for obstacle in srj['obstacles']:
        require(set(obstacle) == {'type', 'layers', 'center', 'width', 'height', 'connectedTo'},
                'unexpected SRJ obstacle fields')
        require(set(obstacle['center']) == {'x', 'y'}, 'unexpected SRJ center fields')
        require(obstacle['layers'] == ['top'] and obstacle['type'] == 'rect', 'unexpected obstacle')
        require(len(obstacle['connectedTo']) == 1 and obstacle['connectedTo'][0] in names, 'unexpected pad ownership')
    for connection in srj['connections']:
        require(set(connection) == {'name', 'pointsToConnect'}, 'unexpected SRJ connection fields')
        name = connection['name']
        points = connection['pointsToConnect']
        require(all(set(point) == {'x', 'y', 'layer'} for point in points),
                'unexpected SRJ terminal fields')
        require(len(points) == 2 and all(p['layer'] == 'top' for p in points), 'expected two top-side terminals')
        require(sorted((p['x'], p['y']) for p in points) == sorted(v[:2] for v in pads[name]), f'{name}: native/SRJ positions differ')
        obstacles = sorted((o['center']['x'], o['center']['y'], o['width'], o['height']) for o in srj['obstacles'] if name in o['connectedTo'])
        require(obstacles == sorted(pads[name]), f'{name}: native/SRJ pad dimensions differ')
    return len(pads), sum(map(len, pads.values())), expected_pads


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--reference', type=Path)
    parser.add_argument('--repeats', type=int, choices=range(1, 11), default=3)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / 'summary.csv').unlink(missing_ok=True)
    specs = json.loads((ROOT / 'manifest.json').read_text())['boards']
    rows = []
    with tempfile.TemporaryDirectory(prefix='bga-regenerate-') as temp:
        regenerated = Path(temp)
        subprocess.run([sys.executable, str(ROOT / 'generate.py'), '--out', temp], check=True, timeout=30)
        for spec in specs:
            tier = spec['tier']
            for filename in [f'{tier}.kicad_pcb', 'unrouted.srj.json']:
                relative = Path(tier) / filename
                require((ROOT / relative).read_bytes() == (regenerated / relative).read_bytes(), f'{relative}: regeneration changed bytes')
                if args.reference:
                    require((ROOT / relative).read_bytes() == (args.reference / relative).read_bytes(), f'{relative}: reference changed bytes')
        phases = [('bundled', ROOT), ('regenerated', regenerated)]
        if args.reference:
            phases.insert(0, ('reference', args.reference.resolve()))
        for phase, source in phases:
            for spec in specs:
                tier = spec['tier']
                nets, pads, expected_pads = geometry(source, spec)
                pcb = source / tier / f'{tier}.kicad_pcb'
                srj = source / tier / 'unrouted.srj.json'
                for repeat in range(1, args.repeats + 1):
                    report = args.out / f'{phase}-{tier}-{repeat}.json'
                    report.unlink(missing_ok=True)
                    subprocess.run(['kicad-cli', 'pcb', 'drc', '--format', 'json', '-o', str(report), str(pcb)], check=True, timeout=180)
                    drc = json.loads(report.read_text())
                    validate_report(drc, expected_pads)
                    rows.append([phase, tier, repeat, nets, pads, 4, 0, 100, digest(pcb), digest(srj), digest(report)])
    with (args.out / 'summary.csv').open('w', newline='') as stream:
        writer = csv.writer(stream, lineterminator='\n')
        writer.writerow(['phase', 'tier', 'repeat', 'nets', 'pads', 'layers', 'violations', 'unconnected_items', 'pcb_sha256', 'srj_sha256', 'report_sha256'])
        writer.writerows(rows)
    print(f'Validated {len(rows)} native input checks; geometry and regenerated bytes match.')


if __name__ == '__main__':
    main()
