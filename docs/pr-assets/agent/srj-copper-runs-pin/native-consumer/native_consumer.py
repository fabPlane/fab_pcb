"""Narrow diagnostic consumer for retained top-copper rectangular-pad fixture.
Not a general SRJ importer. Native checker and rules are unmodified.
"""
import hashlib
import json
import math
from pathlib import Path
import subprocess
import pcbnew as pcb

ROOT = Path(__file__).resolve().parents[5]
OUT = Path(__file__).resolve().parent
SOURCE = OUT / 'samples.json'
INPUT = OUT / 'input.srj.json'
fixture = json.loads(INPUT.read_text())
samples = json.loads(SOURCE.read_text())
assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == '11b2629eb586e5f12658094da366111c8a43f21a69c8a19687b2388d3d963e86'
assert hashlib.sha256(INPUT.read_bytes()).hexdigest() == 'c93f569382db6ccaf24bda4c2d8238b91e080bfeae4ca274ca4938f11df0ce45'
assert [(s['mode'], s['repeat']) for s in samples] == [(m,r) for m in ('before','after') for r in (1,2,3)]

def point(x, y):
    return pcb.VECTOR2I(pcb.FromMM(x), pcb.FromMM(y))

def make_board(traces):
    board = pcb.BOARD()
    net = pcb.NETINFO_ITEM(board, 'NET1', 1)
    board.Add(net)
    for i, obstacle in enumerate(fixture['obstacles'], 1):
        assert obstacle['layers'] == ['top'] and obstacle['connectedTo'] == ['NET1']
        fp = pcb.FOOTPRINT(board)
        fp.SetReference(f'J{i}')
        fp.SetPosition(point(obstacle['center']['x'], obstacle['center']['y']))
        pad = pcb.PAD(fp)
        pad.SetNumber('1')
        pad.SetAttribute(pcb.PAD_ATTRIB_SMD)
        pad.SetShape(pcb.PAD_SHAPE_RECT)
        layers = pcb.LSET()
        layers.AddLayer(pcb.F_Cu)
        pad.SetLayerSet(layers)
        pad.SetSize(point(obstacle['width'], obstacle['height']))
        pad.SetPosition(fp.GetPosition())
        pad.SetNet(net)
        fp.Add(pad)
        board.Add(fp)
    for a, b in [((0,0),(20,0)), ((20,0),(20,12)), ((20,12),(0,12)), ((0,12),(0,0))]:
        edge = pcb.PCB_SHAPE()
        edge.SetShape(pcb.SHAPE_T_SEGMENT)
        edge.SetLayer(pcb.Edge_Cuts)
        edge.SetStart(point(*a))
        edge.SetEnd(point(*b))
        edge.SetWidth(pcb.FromMM(0.05))
        board.Add(edge)
    for trace in traces:
        assert trace['connection_name'] == 'NET1'
        route = trace['route']
        assert all(p['route_type'] == 'wire' and p['layer'] == 'top' for p in route)
        for a, b in zip(route, route[1:]):
            assert a['width'] == b['width']
            track = pcb.PCB_TRACK(board)
            track.SetStart(point(a['x'], a['y']))
            track.SetEnd(point(b['x'], b['y']))
            track.SetLayer(pcb.F_Cu)
            track.SetWidth(pcb.FromMM(a['width']))
            track.SetNet(net)
            board.Add(track)
    return board

rows = []
controls = [('unrouted', []), ('missing-run', samples[3]['result']['srj']['traces'][:1])]
for mode, repeat, traces in [(s['mode'], s['repeat'], s['result']['srj']['traces']) for s in samples] + [(m, 1, t) for m,t in controls]:
    label = f'{mode}-{repeat}'
    board = make_board(traces)
    path = OUT / f'{label}.kicad_pcb'
    pcb.SaveBoard(str(path), board)
    loaded = pcb.LoadBoard(str(path))
    tracks = list(loaded.GetTracks())
    assert len(list(loaded.GetFootprints())) == 3
    assert all(t.GetNetname() == 'NET1' for t in tracks)
    expected = sum(math.hypot(b['x']-a['x'], b['y']-a['y']) for t in traces for a,b in zip(t['route'], t['route'][1:]))
    length = sum(pcb.ToMM(t.GetLength()) for t in tracks)
    assert abs(expected-length) < 0.00001
    report_path = OUT / f'{label}.drc.json'
    command = ['kicad-cli','pcb','drc','--format','json','--refill-zones','--severity-all','--output',str(report_path),str(path)]
    run = subprocess.run(command, capture_output=True, text=True, timeout=45)
    assert run.returncode == 0, run.stderr
    report = json.loads(report_path.read_text())
    rows.append(dict(mode=mode, repeat=repeat, tracks=len(tracks), length_mm=length,
                     unconnected=len(report['unconnected_items']),
                     errors=[v['type'] for v in report['violations'] if v['severity']=='error'],
                     warnings=[v['type'] for v in report['violations'] if v['severity']=='warning']))
assert all(r['unconnected']==0 for r in rows if r['mode'] in ('before','after'))
assert all(not r['errors'] and not r['warnings'] for r in rows)
assert rows[-2]['unconnected'] == 2 and rows[-1]['unconnected'] == 1
assert all(r['tracks']==(3 if r['mode']=='before' else 2) for r in rows[:6])
summary = dict(input_sha256=hashlib.sha256(INPUT.read_bytes()).hexdigest(),
               samples_sha256=hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
               kicad_version=pcb.Version(), rows=rows)
(OUT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
