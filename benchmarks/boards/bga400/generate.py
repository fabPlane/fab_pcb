#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Generate original eight-layer 400-net BGA escape candidate; no libraries/inputs.

Usage: /usr/bin/python3 scripts/gen/bga400.py OUTPUT [--seed 6408]
All layers are signal layers. No plane, pair or length constraints are implied.
Native DRC is an input admission check, not evidence of routed feasibility.
"""
import argparse
import hashlib
import json
from pathlib import Path
import random
import subprocess
import uuid

PARAMETERS = dict(seed=6408, layers=8, balls=400, nets=400, pads=800,
                  pitch_mm=0.65, ball_mm=0.30, target_mm=0.40,
                  target_pitch_mm=0.8, board_mm=[60, 60], clearance_mm=0.1,
                  track_mm=0.1, via_mm=0.3, drill_mm=0.1)


def generate(out, seed=6408):
    import pcbnew as p
    out.mkdir(parents=True, exist_ok=False)
    def uid(key):
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f'bga400/{seed}/{key}'))
    lines = ['(kicad_pcb (version 20240108) (generator "pcbnew")',
             '(general (thickness 1.6)) (paper "A4")',
             '(layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal)',
             '(3 "In3.Cu" signal) (4 "In4.Cu" signal) (5 "In5.Cu" signal)',
             '(6 "In6.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))',
             '(setup (pad_to_mask_clearance 0)) (net 0 "")']
    lines += [f'(net {n} "N{n}")' for n in range(1, 401)]
    def pad(n, x, y, size):
        return (f'(pad "{n}" smd circle (at {x:.6f} {y:.6f}) (size {size} {size}) '
                f'(layers "F.Cu" "F.Mask") (net {n} "N{n}") (uuid "{uid(f"pad/{n}/{size}")}"))')
    def footprint(ref, x, y, pads):
        lines.append(f'(footprint "escape" (layer "F.Cu") (at {x} {y}) (uuid "{uid(ref)}")')
        lines.append(f'(property "Reference" "{ref}" (at 0 -1) (layer "F.Fab") (uuid "{uid(ref+"/ref")}"))')
        lines.extend(pads)
        lines.append(')')
    footprint('U1', 30, 30, [pad(i+1, (i % 20-9.5)*0.65, (i//20-9.5)*0.65, 0.30) for i in range(400)])
    permutation = list(range(1, 401))
    random.Random(seed).shuffle(permutation)
    for i, n in enumerate(permutation):
        side, index = divmod(i, 100)
        col, row = divmod(index, 2)
        along, cross = 10.4+0.8*col, 5+1.5*row
        x, y = [(along,cross),(60-cross,along),(along,60-cross),(cross,along)][side]
        footprint(f'J{i+1}', round(x, 6), round(y, 6), [pad(n, 0, 0, 0.4)])
    lines.append(f'(gr_rect (start 0 0) (end 60 60) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts") (uuid "{uid("outline")}"))')
    lines.append(')')
    board = out/'bga400.kicad_pcb'
    board.write_text('\n'.join(lines)+'\n')
    project = out/'bga400.kicad_pro'
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
    if (b.GetCopperLayerCount()!=8 or len(stack)!=8 or len(pads)!=800
            or len(ownership)!=400 or set(ownership.values())!={2} or len(b.GetTracks()) or len(b.Zones())):
        raise RuntimeError('native topology does not match parameters')
    dsn = out/'bga400.dsn'
    if not p.ExportSpecctraDSN(b, str(dsn)):
        raise RuntimeError('DSN export failed')
    _, tail = dsn.read_text().split('\n', 1)
    dsn.write_text('(pcb "bga400.dsn"\n'+tail)
    report = out/'drc.json'
    subprocess.run(['kicad-cli','pcb','drc','--format','json','--severity-all','-o',str(report),str(board)],
                   check=True, capture_output=True, timeout=90)
    data = json.loads(report.read_text())
    if data['violations'] or len(data['unconnected_items'])!=400:
        raise RuntimeError(f'unexpected native DRC: {len(data["violations"])} violations, {len(data["unconnected_items"])} opens')
    summary = dict(schema=1, parameters={**PARAMETERS, 'seed': seed}, copper_stack=stack,
                   native_errors=0, native_warnings=0, native_opens=400,
                   checker=subprocess.check_output(['kicad-cli','--version'],text=True).strip(),
                   sha256={f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in (board,project,dsn)})
    (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('out',type=Path)
    parser.add_argument('--seed',type=int,default=6408)
    args = parser.parse_args()
    print(json.dumps(generate(args.out.resolve(),args.seed),indent=2))
