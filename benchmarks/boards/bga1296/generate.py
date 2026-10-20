#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Generate original eight-layer 1296-net BGA escape candidate; no libraries/inputs.

Usage: /usr/bin/python3 scripts/gen/bga1296.py OUTPUT [--seed 6596]
All layers are signal layers. No plane, pair or length constraints are implied.
Native DRC is an input admission check, not evidence of routed feasibility.
"""
import argparse
import hashlib
import json
from pathlib import Path
import random
import re
from collections import Counter
from decimal import Decimal, InvalidOperation
import subprocess
import uuid

PARAMETERS = dict(seed=6596, layers=8, balls=1296, nets=1296, pads=2592,
                  pitch_mm=0.5, ball_mm=0.20, target_mm=0.40,
                  target_pitch_mm=0.8, board_mm=[90, 90], clearance_mm=0.1,
                  track_mm=0.1, via_mm=0.3, drill_mm=0.1,
                  keepouts_mm=[[29, 31, 32, 59], [58, 31, 61, 59]])


def validate_report(data, native_opens, board_name):
    """Admit the expected diagnostic, never treat its limited opens as exact quality."""
    if not isinstance(data, dict):
        raise RuntimeError('native DRC report must be an object')
    if (data.get('$schema') != 'https://schemas.kicad.org/drc.v1.json'
            or data.get('source') != board_name
            or not isinstance(data.get('kicad_version'), str)
            or not data['kicad_version'].strip()):
        raise RuntimeError('native DRC report identity/schema mismatch')
    severities = data.get('included_severities')
    if (not isinstance(severities, list)
            or any(not isinstance(item, str) for item in severities)
            or not {'error', 'warning', 'exclusion'}.issubset(severities)):
        raise RuntimeError('native DRC report omitted severities')
    for section in ('violations', 'schematic_parity', 'unconnected_items'):
        if not isinstance(data.get(section), list):
            raise RuntimeError(f'native DRC report missing list: {section}')
    if data['violations'] or data['schematic_parity']:
        raise RuntimeError('unexpected native DRC violations or schematic parity findings')
    findings = data['unconnected_items']
    if len(findings) != min(native_opens, 499):
        raise RuntimeError('unexpected native DRC open count')
    if any(not isinstance(item, dict) or item.get('type') != 'unconnected_items'
           or item.get('severity') != 'error' for item in findings):
        raise RuntimeError('unexpected native DRC open finding')


def validate_keepouts(exported, layers):
    """Require the exact generated rectangular keepouts in micrometre coordinates.

    This deliberately admits only this fixture's exporter grammar, not arbitrary DSN.
    Counts alone cannot detect moved, resized or duplicated obstacles.
    """
    if len(layers) != 8 or len(set(layers)) != 8:
        raise RuntimeError('unexpected keepout copper stack')
    if re.findall(r'\(unit\s+([^()]*)\)', exported) != ['um']:
        raise RuntimeError('unexpected DSN coordinate unit')
    polygons = re.findall(r'\(keepout\s+""\s+\(polygon\s+([^()]*)\)\s*\)', exported)
    if len(polygons) != 16 or len(re.findall(r'\(keepout\b', exported)) != 16:
        raise RuntimeError('unexpected DSN keepout grammar/count')
    expected = Counter()
    for x1, y1, x2, y2 in PARAMETERS['keepouts_mm']:
        coordinates = tuple(Decimal(v * 1000) for v in
                            (x1, -y1, x2, -y1, x2, -y2, x1, -y2, x1, -y1))
        for layer in layers:
            expected[layer, coordinates] += 1
    actual = Counter()
    for polygon in polygons:
        fields = polygon.split()
        if len(fields) != 12:
            raise RuntimeError('unexpected DSN keepout vertex count')
        try:
            values = tuple(Decimal(v) for v in fields[1:])
        except InvalidOperation as error:
            raise RuntimeError('invalid DSN keepout coordinates') from error
        if any(not value.is_finite() for value in values) or values[0] != 0:
            raise RuntimeError('unexpected DSN keepout aperture/coordinates')
        actual[fields[0], values[1:]] += 1
    if actual != expected:
        raise RuntimeError('DSN keepout geometry differs from fixture parameters')


def generate(out, seed=6596):
    import pcbnew as p
    out.mkdir(parents=True, exist_ok=False)
    def uid(key):
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f'bga1296/{seed}/{key}'))
    lines = ['(kicad_pcb (version 20240108) (generator "pcbnew")',
             '(general (thickness 1.6)) (paper "A4")',
             '(layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal)',
             '(3 "In3.Cu" signal) (4 "In4.Cu" signal) (5 "In5.Cu" signal)',
             '(6 "In6.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))',
             '(setup (pad_to_mask_clearance 0)) (net 0 "")']
    lines += [f'(net {n} "N{n}")' for n in range(1, 1297)]
    def pad(n, x, y, size):
        return (f'(pad "{n}" smd circle (at {x:.6f} {y:.6f}) (size {size} {size}) '
                f'(layers "F.Cu" "F.Mask") (net {n} "N{n}") (uuid "{uid(f"pad/{n}/{size}")}"))')
    def footprint(ref, x, y, pads):
        lines.append(f'(footprint "escape" (layer "F.Cu") (at {x} {y}) (uuid "{uid(ref)}")')
        lines.append(f'(property "Reference" "{ref}" (at 0 -1) (layer "F.Fab") (uuid "{uid(ref+"/ref")}"))')
        lines.extend(pads)
        lines.append(')')
    footprint('U1', 45, 45, [pad(i+1, (i % 36-17.5)*0.5, (i//36-17.5)*0.5, 0.20) for i in range(1296)])
    permutation = list(range(1, 1297))
    random.Random(seed).shuffle(permutation)
    for i, n in enumerate(permutation):
        side, index = divmod(i, 324)
        col, row = divmod(index, 4)
        along, cross = 13+0.8*col, 5+1.5*row
        x, y = [(along,cross),(90-cross,along),(along,90-cross),(cross,along)][side]
        footprint(f'J{i+1}', round(x, 6), round(y, 6), [pad(n, 0, 0, 0.4)])
    lines.append(f'(gr_rect (start 0 0) (end 90 90) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts") (uuid "{uid("outline")}"))')
    for index, (x1, y1, x2, y2) in enumerate(PARAMETERS['keepouts_mm']):
        lines.append(f'(zone (net 0) (net_name "") (layers "*.Cu") (uuid "{uid(f"keepout/{index}")}") (hatch edge 0.5) '
                     '(connect_pads (clearance 0)) (min_thickness 0.25) '
                     '(keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed)) '
                     f'(polygon (pts (xy {x1} {y1}) (xy {x2} {y1}) (xy {x2} {y2}) (xy {x1} {y2}))))')
    lines.append(')')
    board = out/'bga1296.kicad_pcb'
    board.write_text('\n'.join(lines)+'\n')
    project = out/'bga1296.kicad_pro'
    project.write_text(json.dumps(dict(
        meta=dict(filename=project.name, version=3),
        board=dict(design_settings=dict(rules=dict(min_clearance=0.1, min_track_width=0.1,
            min_via_diameter=0.3, min_via_annular_width=0.1, min_through_hole_diameter=0.1))),
        net_settings=dict(meta=dict(version=5), classes=[dict(name='Default', clearance=0.1,
            track_width=0.1, via_diameter=0.3, via_drill=0.1)], netclass_patterns=[])),indent=2)+'\n')
    b = p.LoadBoard(str(board))
    nc = b.GetDesignSettings().m_NetSettings.GetDefaultNetclass()
    observed = [round(p.ToMM(x),6) for x in (nc.GetClearance(),nc.GetTrackWidth(),nc.GetViaDiameter(),nc.GetViaDrill())]
    if observed != [0.1,0.1,0.3,0.1]:
        raise RuntimeError(f'native project rules were not loaded: {observed}')
    pads = [pad for f in b.GetFootprints() for pad in f.Pads()]
    ownership = {}
    for terminal in pads:
        ownership[terminal.GetNetname()] = ownership.get(terminal.GetNetname(), 0)+1
    stack = [(int(layer), b.GetLayerName(layer)) for layer in b.GetEnabledLayers().CuStack()]
    if (b.GetCopperLayerCount()!=8 or len(stack)!=8 or len(pads)!=2592
            or len(ownership)!=1296 or set(ownership.values())!={2} or len(b.GetTracks()) or len(b.Zones()) != 2
            or any(not z.GetIsRuleArea() or not z.GetDoNotAllowTracks() or not z.GetDoNotAllowVias()
                   or len(z.GetLayerSet().CuStack()) != 8 for z in b.Zones())):
        raise RuntimeError('native topology does not match parameters')
    dsn = out/'bga1296.dsn'
    if not p.ExportSpecctraDSN(b, str(dsn)):
        raise RuntimeError('DSN export failed')
    _, tail = dsn.read_text().split('\n', 1)
    dsn.write_text('(pcb "bga1296.dsn"\n'+tail)
    exported = dsn.read_text()
    validate_keepouts(exported, [name for _, name in stack])
    native_opens = b.GetConnectivity().GetUnconnectedCount(False)
    if native_opens != 1296:
        raise RuntimeError(f'unexpected native connectivity count: {native_opens}')
    report = out/'drc.json'
    subprocess.run(['kicad-cli','pcb','drc','--format','json','--severity-all','-o',str(report),str(board)],
                   check=True, capture_output=True, timeout=90)
    data = json.loads(report.read_text())
    validate_report(data, native_opens, board.name)
    summary = dict(schema=1, parameters={**PARAMETERS, 'seed': seed}, copper_stack=stack,
                   native_errors=0, native_warnings=0, native_connectivity_opens=native_opens,
                   reported_opens=len(data['unconnected_items']), report_limit_reached=True,
                   checker=subprocess.check_output(['kicad-cli','--version'],text=True).strip(),
                   sha256={f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in (board,project,dsn)})
    (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('out',type=Path)
    parser.add_argument('--seed',type=int,default=6596)
    args = parser.parse_args()
    print(json.dumps(generate(args.out.resolve(),args.seed),indent=2))
