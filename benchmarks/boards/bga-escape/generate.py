# SPDX-License-Identifier: MIT
# See LICENSE.
"""Deterministic 100-ball escape fixtures; no external libraries (MIT).

Coordinates are mm. B1/B2 keep net permutation, bounds and targets fixed,
changing only BGA pitch and pad size. Native default KiCad rules and SRJ's
explicit 0.15 mm track width are different constraint models.
"""
import argparse
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def generate(spec, output):
    tier = spec['tier']
    params = spec['generation']
    pitch, size, seed = params['pitch_mm'], params['pad_mm'], params['seed']
    count = spec['nets']
    assert count == 100 and spec['layers'] == 4
    assert params['balls'] == count and params['board_mm'] == [50, 50]
    assert 0 < size < pitch
    permutation = list(range(count))
    random.Random(seed).shuffle(permutation)
    pcb = ['(kicad_pcb (version 20241229) (generator "bga-corpus")',
           '(general (thickness 1.6)) (paper "A4")',
           '(layers (0 "F.Cu" signal) (2 "In1.Cu" signal) (4 "In2.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))',
           '(setup (pad_to_mask_clearance 0))']
    pcb.extend(f'(net {n+1} "N{n+1}")' for n in range(count))
    obstacles, connections = [], []
    def pad(number, x, y, width):
        return f'(pad "{number}" smd rect (at {x:.6f} {y:.6f}) (size {width} {width}) (layers "F.Cu" "F.Paste" "F.Mask") (net {number} "N{number}"))'
    pcb.append('(footprint "BGA100" (layer "F.Cu") (at 25 25) (property "Reference" "U1" (at 0 -6) (layer "F.SilkS") (hide yes)) (attr smd)')
    balls = []
    for n in range(count):
        x, y = (n % 10 - 4.5) * pitch, (n // 10 - 4.5) * pitch
        pcb.append(pad(n+1, x, y, size))
        balls.append((round(25+x, 6), round(25+y, 6)))
    pcb.append(')')
    targets = {}
    for index, net in enumerate(permutation):
        side, offset = divmod(index, 25)
        t = 10.6 + offset * 1.2
        x, y = [(t, 5), (45, t), (t, 45), (5, t)][side]
        targets[net] = (round(x, 6), round(y, 6))
        pcb.append(f'(footprint "EscapePad" (layer "F.Cu") (at {x:.6f} {y:.6f}) (property "Reference" "J{index+1}" (at 0 -1) (layer "F.SilkS") (hide yes)) (attr smd) {pad(net+1, 0, 0, .6)})')
    for n, (x, y) in enumerate(balls):
        tx, ty = targets[n]
        connections.append(dict(name=f'N{n+1}', pointsToConnect=[dict(x=x,y=y,layer='top'),dict(x=tx,y=ty,layer='top')]))
        for px, py, width in [(x,y,size),(tx,ty,.6)]:
            obstacles.append(dict(type='rect',layers=['top'],center=dict(x=px,y=py),width=width,height=width,connectedTo=[f'N{n+1}']))
    for a,b in [((0,0),(50,0)),((50,0),(50,50)),((50,50),(0,50)),((0,50),(0,0))]:
        pcb.append(f'(gr_line (start {a[0]} {a[1]}) (end {b[0]} {b[1]}) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))')
    pcb.append(')')
    destination = output / tier
    destination.mkdir(parents=True, exist_ok=True)
    (destination / f'{tier}.kicad_pcb').write_text('\n'.join(pcb)+'\n')
    srj = dict(layerCount=4,minTraceWidth=.15,obstacles=obstacles,connections=connections,bounds=dict(minX=0,maxX=50,minY=0,maxY=50))
    (destination / 'unrouted.srj.json').write_text(json.dumps(srj,indent=2)+'\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,default=ROOT)
    args = parser.parse_args()
    manifest = json.loads((ROOT/'manifest.json').read_text())
    for spec in manifest['boards']:
        generate(spec, args.out)
