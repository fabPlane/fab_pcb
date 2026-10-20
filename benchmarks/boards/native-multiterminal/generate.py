#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Generate a three-terminal connectivity control and measure fresh native DRC.

No random inputs or footprint libraries. Usage: native_multiterminal.py OUTDIR
Boards are diagnostic controls, not a ranked suite or a routing gain.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import uuid


def generate(out):
    import pcbnew as p
    out.mkdir(parents=True, exist_ok=False)
    results = []
    terminal_signature = None
    for connected in range(3):
        name = ('unrouted', 'partial', 'complete')[connected]
        def uid(key):
            return str(uuid.uuid5(uuid.NAMESPACE_URL, 'native-multiterminal/'+key))
        text = '(kicad_pcb (version 20240108) (generator "pcbnew")\n'
        text += '(general (thickness 1.6)) (paper "A4")\n'
        text += '(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))\n'
        text += '(setup (pad_to_mask_clearance 0)) (net 0 "") (net 1 "SIGNAL")\n'
        for i, x in enumerate((10, 20, 30)):
            text += f'''(footprint "terminal" (layer "F.Cu") (at {x} 10) (uuid "{uid('f'+str(i))}")
 (property "Reference" "J{i+1}" (at 0 -2) (layer "F.SilkS") (uuid "{uid('r'+str(i))}"))
 (property "Value" "terminal" (at 0 2) (layer "F.Fab") (uuid "{uid('v'+str(i))}"))
 (pad "1" smd circle (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask")
 (net 1 "SIGNAL") (uuid "{uid('p'+str(i))}")))\n'''
        text += f'''(gr_rect (start 5 5) (end 35 15) (stroke (width 0.05) (type default))
 (fill none) (layer "Edge.Cuts") (uuid "{uid('outline')}"))\n'''
        for i in range(connected):
            text += f'''(segment (start {10+10*i} 10) (end {20+10*i} 10) (width 0.25)
 (layer "F.Cu") (net 1) (uuid "{uid('t'+str(i))}"))\n'''
        board = out / (name + '.kicad_pcb')
        board.write_text(text + ')\n')
        b = p.LoadBoard(str(board))
        if not p.ExportSpecctraDSN(b, str(out / (name + '.dsn'))):
            raise RuntimeError('DSN export failed')
        dsn = out / (name + '.dsn')
        _, tail = dsn.read_text().split('\n', 1)
        dsn.write_text(f'(pcb "{name}.dsn"\n' + tail)
        terminals = sorted((f.GetReference(), pad.GetNumber(), pad.GetNetname(),
                            pad.GetPosition().x, pad.GetPosition().y,
                            pad.GetSize().x, pad.GetSize().y,
                            int(pad.GetShape()), pad.GetLayerSet().FmtHex())
                           for f in b.GetFootprints() for pad in f.Pads())
        if len(terminals) != 3 or {t[2] for t in terminals} != {'SIGNAL'}:
            raise RuntimeError('unexpected terminal ownership')
        if terminal_signature is None:
            terminal_signature = terminals
        if terminals != terminal_signature or len(b.GetTracks()) != connected:
            raise RuntimeError('terminal geometry changed or unexpected tracks')
        report = out / (name + '-drc.json')
        subprocess.run(['kicad-cli', 'pcb', 'drc', '--format', 'json', '--severity-all',
                        '-o', str(report), str(board)], check=True, timeout=60,
                       capture_output=True)
        data = json.loads(report.read_text())
        errors = [v for v in data['violations'] if v['severity'] == 'error']
        opens = len(data['unconnected_items'])
        if errors or opens != 2-connected:
            raise RuntimeError(f'{name}: unexpected DRC: {len(errors)} errors / {opens} opens')
        results.append(dict(board=name, native_errors=len(errors), native_opens=opens,
                            native_warnings=len(data['violations'])-len(errors),
                            candidate_completion=connected/2,
                            legacy_net_denominator_completion=max(0, 1-opens),
                            board_sha256=hashlib.sha256(board.read_bytes()).hexdigest()))
    summary = dict(schema=1, terminals=3, nets=1, initial_opens=2, results=results, terminal_signature=terminal_signature,
                   checker=subprocess.check_output(['kicad-cli', '--version'], text=True).strip(),
                   limitation='Diagnostic scalar native-open control; production scoring unchanged.')
    (out / 'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('out', type=Path)
    print(json.dumps(generate(parser.parse_args().out.resolve()), indent=2))
