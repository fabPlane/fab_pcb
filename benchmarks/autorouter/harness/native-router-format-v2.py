#!/usr/bin/python3
# SPDX-License-Identifier: GPL-3.0-only
"""Standalone TraceMaker format gate. Port of v1's pure transform step only.

No product imports/runtime. Failed fidelity gates prevent routing that fixture.
"""
import argparse, hashlib, importlib.util, json, pathlib, re, subprocess
import pcbnew

class Atom(str):
    def __new__(cls, text, quoted=False):
        obj = str.__new__(cls, text)
        obj.quoted = quoted
        return obj

def parse(text):
    stack, root = [], None
    for t in re.findall(r'"(?:\\.|[^"\\])*"|\(|\)|[^\s()]+', text):
        if t == '(':
            node = []
            if stack:
                stack[-1].append(node)
            else:
                root = node
            stack.append(node)
        elif t == ')':
            stack.pop()
        else:
            stack[-1].append(Atom(json.loads(t) if t.startswith('"') else t, t.startswith('"')))
    if stack:
        raise ValueError('unbalanced input')
    return root

def dump(node):
    if isinstance(node, list):
        return '(' + ' '.join(dump(n) for n in node) + ')'
    return json.dumps(str(node), ensure_ascii=False) if getattr(node, 'quoted', False) else str(node)

def kids(node, key):
    return [n for n in node if isinstance(n, list) and n and n[0] == key]

def kid(node, key):
    return next(iter(kids(node, key)), None)

def convert(src, dst):
    root = parse(src.read_text())
    count = 0
    for fp in kids(root, 'footprint') + kids(root, 'module'):
        for node in [fp, *kids(fp, 'pad')]:
            trans = kid(node, 'transform')
            if trans:
                if any(n[0] not in ('translate', 'rotate') for n in trans[1:]):
                    raise ValueError('unsupported transform component')
                tr, rot = kid(trans, 'translate'), kid(trans, 'rotate')
                if not tr or len(tr) != 3 or (rot and len(rot) != 2):
                    raise ValueError('unsupported transform dimensions')
                node[node.index(trans)] = [Atom('at'), tr[1], tr[2], rot[1] if rot else Atom('0')]
                count += 1
    # Legacy inputs keep exact bytes. Converted inputs keep every other AST node.
    dst.write_bytes(src.read_bytes() if not count else (dump(root) + '\n').encode())
    return count

def pad_rows(board):
    rows = []
    for fp in board.GetFootprints():
        for p in fp.Pads():
            rows.append(dict(ref=fp.GetReference(), num=p.GetNumber(), net=p.GetNetname(),
                x=p.GetPosition().x, y=p.GetPosition().y, w=p.GetSize().x, h=p.GetSize().y,
                angle=p.GetOrientationDegrees() % 180,
                drill_w=p.GetDrillSize().x, drill_h=p.GetDrillSize().y,
                attr={pcbnew.PAD_ATTRIB_PTH:'thru_hole',pcbnew.PAD_ATTRIB_SMD:'smd',
                      pcbnew.PAD_ATTRIB_NPTH:'np_thru_hole',pcbnew.PAD_ATTRIB_CONN:'connect'}[p.GetAttribute()],
                layers=sorted(board.GetLayerName(i) for i in board.GetEnabledLayers().CuStack() if p.IsOnLayer(i))))
    return sorted(rows, key=lambda p: (p['ref'], p['num'], p['x'], p['y']))

def xy(p):return [p.x,p.y]
def snapshot(b):
 pads=[];fps=[];outline=[]
 for f in b.GetFootprints():
  fps.append([f.GetReference(),f.GetValue(),f.GetFPIDAsString(),xy(f.GetPosition()),round(f.GetOrientationDegrees(),6),f.GetLayer()])
  for p in f.Pads():
   pads.append([f.GetReference(),p.GetNumber(),p.GetNetname(),xy(p.GetPosition()),xy(p.GetSize()),round(p.GetOrientationDegrees()%180,6),int(p.GetShape()),int(p.GetAttribute()),xy(p.GetDrillSize()),[i for i in b.GetEnabledLayers().CuStack() if p.IsOnLayer(i)]])
 for g in b.GetDrawings():
  if g.GetLayer()==pcbnew.Edge_Cuts:
   if hasattr(g,'GetStart'):
    outline.append([int(g.GetShape()),xy(g.GetStart()),xy(g.GetEnd()),xy(g.GetCenter())])
   else:
    # Non-shape Edge.Cuts items (PCB_TARGET) have position/size, not endpoints.
    outline.append([g.GetClass(),int(g.GetShape()),xy(g.GetPosition()),
                    int(g.GetSize()),int(g.GetWidth()),int(g.GetLayer())])
 return {'footprints':sorted(fps,key=str),'pads':sorted(pads,key=str),'outline':sorted(outline,key=str),'layers':[int(i) for i in b.GetEnabledLayers().CuStack()],'zones':b.GetAreaCount()}

def gate(src, dst, tm, out):
    out.mkdir(parents=True, exist_ok=False)
    checks, commands, errors = {}, [], []
    result = dict(input_sha256=hashlib.sha256(src.read_bytes()).hexdigest(), commands=commands)
    try:
        result['transforms_replaced'] = convert(src, dst)
        # Native loading rejects unsupported formats rather than claiming fidelity.
        a, b = pcbnew.LoadBoard(str(src)), pcbnew.LoadBoard(str(dst))
        expected = pad_rows(a)
        checks['native_pad_readback'] = expected == pad_rows(b)
        check_path=pathlib.Path(__file__).resolve().parent/'native-check-v3.py'
        spec=importlib.util.spec_from_file_location('native_check',check_path)
        native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
        checks['native_geometry_readback']=snapshot(a)==snapshot(b)
        checks['version_preserved'] = kid(parse(src.read_text()), 'version') == kid(parse(dst.read_text()), 'version')
        for name, board in [('native',src),('converted',dst)]:
            argv = ['/usr/bin/kicad-cli','pcb','export','ipcd356','-o',str(out/(name+'.ipc')),str(board)]
            p = subprocess.run(argv, capture_output=True, timeout=120)
            commands.append(dict(argv=argv, exit_code=p.returncode))
            (out/(name+'.stdout.log')).write_bytes(p.stdout)
            (out/(name+'.stderr.log')).write_bytes(p.stderr)
        rows = lambda path: sorted(s for s in path.read_text().splitlines() if s[:3] in ('317','327') and s[20:26].strip() != 'VIA')
        checks['native_ipc_pad_equivalence'] = all(c['exit_code'] == 0 for c in commands) and rows(out/'native.ipc') == rows(out/'converted.ipc')
        argv = [str(tm),'inspect',str(dst),'--json',str(out/'inspect.json')]
        p = subprocess.run(argv, capture_output=True, timeout=120)
        commands.append(dict(argv=argv, exit_code=p.returncode))
        (out/'inspect.stdout.log').write_bytes(p.stdout)
        (out/'inspect.stderr.log').write_bytes(p.stderr)
        remaining = json.loads((out/'inspect.json').read_text())['pads']
        for pad in expected:
            candidates = [p for p in remaining if p['ref'] == pad['ref'] and p['num'] == pad['num']]
            if not candidates:
                errors.append(dict(missing=pad)); continue
            match = min(candidates,key=lambda p:abs(p['x']-pad['x'])+abs(p['y']-pad['y']))
            remaining.remove(match)
            if not (all(abs(match[k]-pad[k]) <= 2 for k in ('x','y','w','h','drill_w','drill_h'))
                    and abs((match['angle']-pad['angle']+90)%180-90)<1e-5
                    and all(match[k]==pad[k] for k in ('net','attr'))
                    and sorted(match['layers'])==pad['layers']):
                errors.append(dict(native=pad, engine=match))
        checks['engine_pad_equivalence'] = not errors and not remaining and p.returncode == 0
    except Exception as exc:
        errors.append(dict(error=str(exc)))
    result.update(checks=checks, differences=errors, **{'pass':len(checks)==5 and all(checks.values()) and not errors})
    (out/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    return result

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', type=pathlib.Path, required=True)
    ap.add_argument('--output', type=pathlib.Path, required=True)
    ap.add_argument('--tracemaker', type=pathlib.Path, required=True)
    ap.add_argument('--out', type=pathlib.Path, required=True)
    args = ap.parse_args()
    raise SystemExit(0 if gate(args.input,args.output,args.tracemaker,args.out)['pass'] else 2)
