# SPDX-License-Identifier: MIT
"""Qualify identical board placement/rules with and without routing keepouts.
Run from the repository root with a new output directory. No router execution.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import pcbnew as p

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=Path)
parser.add_argument('--generator', type=Path, default=Path('benchmarks/boards/bga1296/generate.py'))
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
spec = importlib.util.spec_from_file_location('candidate_generator', args.generator)
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)
rows = []
for repeat in range(3):
    generated = args.output / f'generated-{repeat}'
    summary = generator.generate(generated)
    source = generated / 'bga1296.kicad_pcb'
    original = source.read_text()
    before = '\n'.join(line for line in original.splitlines() if not line.startswith('(zone ')) + '\n'
    for label, text, zones in [('before', before, 0), ('after', original, 2)]:
        case = args.output / f'{label}-{repeat}'
        case.mkdir()
        board = case / source.name
        board.write_text(text)
        project = case / 'bga1296.kicad_pro'
        project.write_bytes((generated / project.name).read_bytes())
        native = p.LoadBoard(str(board))
        terminals = sorted((f.GetReference(), pad.GetNumber(), pad.GetNetname(),
                            pad.GetPosition().x, pad.GetPosition().y, pad.GetSize().x, pad.GetSize().y)
                           for f in native.GetFootprints() for pad in f.Pads())
        signature = hashlib.sha256(json.dumps(terminals).encode()).hexdigest()
        if len(native.Zones()) != zones or native.GetConnectivity().GetUnconnectedCount(False) != 1296:
            raise RuntimeError('variant native topology mismatch')
        report = case / 'drc.json'
        subprocess.run(['kicad-cli','pcb','drc','--format','json','--severity-all','-o',str(report),str(board)],
                       check=True, capture_output=True, timeout=90)
        generator.validate_report(json.loads(report.read_text()), 1296, board.name)
        dsn = case / 'bga1296.dsn'
        if not p.ExportSpecctraDSN(native, str(dsn)):
            raise RuntimeError('variant DSN export failed')
        tail = dsn.read_text().split('\n', 1)[1]
        dsn.write_text('(pcb "bga1296.dsn"\n' + tail)
        if dsn.read_text().count('(keepout ') != zones * 8:
            raise RuntimeError('variant DSN keepout mismatch')
        rows.append(dict(repeat=repeat, variant=label, native_opens=1296, native_errors=0,
                         native_warnings=0, reported_opens=499, rule_areas=zones,
                         dsn_keepout_polygons=zones*8, terminal_signature=signature,
                         project_sha256=hashlib.sha256(project.read_bytes()).hexdigest(),
                         board_sha256=hashlib.sha256(board.read_bytes()).hexdigest(),
                         dsn_sha256=hashlib.sha256(dsn.read_bytes()).hexdigest()))
if len({x['terminal_signature'] for x in rows}) != 1 or len({x['project_sha256'] for x in rows}) != 1:
    raise RuntimeError('variants changed placement, ownership or project rules')
for label in ('before', 'after'):
    for field in ('board_sha256', 'dsn_sha256'):
        if len({x[field] for x in rows if x['variant'] == label}) != 1:
            raise RuntimeError('non-deterministic variant')
result = dict(repeats=3, checker=summary['checker'], parameters=summary['parameters'], rows=rows,
              limitation='Input qualification only; capped report does not prove exact routed opens or feasibility.')
(args.output / 'qualification.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
