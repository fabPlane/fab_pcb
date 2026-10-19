#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Verify deterministic generation, native geometry/rules and unrouted DRC.

Requires KiCad's pcbnew Python module and kicad-cli. Output is evidence, not a
routability certificate. No routing or frozen benchmark inputs are modified.
"""
import argparse
from collections import Counter
import hashlib
import json
import re
from pathlib import Path
import shutil
import subprocess
import sys


def canonical_dsn(data):
    # Preserve atom/path order; only sort child records in unordered containers.
    tokens = iter(re.findall(r'"(?:\\.|[^"\\])*"|[()]|[^\s()]+', data.decode()))
    def parse():
        values = []
        closed = False
        for token in tokens:
            if token == ')':
                closed = True
                break
            values.append(parse() if token == '(' else token)
        if not closed:
            raise ValueError('Unclosed DSN list')
        if values and values[0] == 'pins':
            return ['pins'] + sorted(values[1:])
        if values and values[0] in {'placement', 'component', 'library', 'image',
                                    'network', 'net', 'class', 'structure', 'padstack'}:
            atoms = [v for v in values if isinstance(v, str)]
            records = sorted((v for v in values if isinstance(v, list)), key=repr)
            return atoms + records
        return values
    assert next(tokens) == '('
    result = parse()
    assert next(tokens, None) is None
    return result


def geometry(board):
    def point(p):
        return [p.x, p.y]
    pads = sorted((f.GetReference(), p.GetNumber(), p.GetNetname(),
                   point(p.GetPosition()), point(p.GetSize()), int(p.GetShape()),
                   p.GetLayerSet().FmtHex(), point(p.GetDrillSize()),
                   p.GetOrientationDegrees(), int(p.GetAttribute()), point(p.GetOffset()))
                  for f in board.GetFootprints() for p in f.Pads())
    footprints = sorted((f.GetReference(), f.GetValue(), point(f.GetPosition()),
                         int(f.GetLayer()), f.GetOrientationDegrees())
                        for f in board.GetFootprints())
    outline = sorted((int(d.GetShape()), int(d.GetLayer()), point(d.GetStart()), point(d.GetEnd()), d.GetWidth())
                     for d in board.GetDrawings())
    return dict(layers=board.GetCopperLayerCount(), footprints=footprints,
                pads=pads, outline=outline, tracks=len(board.GetTracks()),
                zones=len(board.Zones()))


def verify(generator, fixture, out):
    import pcbnew
    out.mkdir(parents=True, exist_ok=False)
    for name in ('first', 'second'):
        subprocess.run([sys.executable, str(generator), str(out / name), '--seed', '6406'],
                       check=True, timeout=30, capture_output=True)
    filename = 'dense6-bga324.kicad_pcb'
    first, second = out / 'first' / filename, out / 'second' / filename
    assert first.read_bytes() == second.read_bytes(), 'generator is not byte deterministic'
    stats = json.loads((out / 'first/stats.json').read_text())
    assert {k: stats[k] for k in ('nets', 'pads', 'connections', 'layers', 'footprints')} == dict(
        nets=263, pads=702, connections=439, layers=6, footprints=30), 'unexpected board topology'
    reference_dir = out / 'reference'
    reference_dir.mkdir()
    reference = reference_dir / filename
    shutil.copyfile(fixture / filename, reference)
    shutil.copyfile(fixture / 'dense6-bga324.kicad_pro', reference.with_suffix('.kicad_pro'))
    # Rules must travel with the native board. Test both the generated and bundled board.
    project = fixture / 'dense6-bga324.kicad_pro'
    minima = json.loads(project.read_text())['board']['design_settings']['rules']
    expected_minima = dict(min_clearance=0.1, min_track_width=0.1, min_via_diameter=0.45,
                           min_through_hole_diameter=0.2, min_via_annular_width=0.1,
                           min_hole_clearance=0.2, min_hole_to_hole=0.25,
                           min_copper_edge_clearance=0.3, min_connection=0.0)
    assert {key: minima[key] for key in expected_minima} == expected_minima, 'wrong native rule minima'
    shutil.copyfile(project, first.with_suffix('.kicad_pro'))
    generated_board = pcbnew.LoadBoard(str(first))
    reference_board = pcbnew.LoadBoard(str(reference))
    assert geometry(generated_board) == geometry(reference_board), 'generated geometry differs'
    for board in (generated_board, reference_board):
        nc = board.GetDesignSettings().m_NetSettings.GetDefaultNetclass()
        values = [nc.GetClearance(), nc.GetTrackWidth(), nc.GetViaDiameter(), nc.GetViaDrill()]
        assert values == [100000, 100000, 450000, 200000], f'wrong default rules: {values}'
    # A fresh process is intentional: project settings must be loaded from disk.
    export_code = ('import pcbnew,sys; b=pcbnew.LoadBoard(sys.argv[1]); '
                   'assert pcbnew.ExportSpecctraDSN(b,"board.dsn")')
    subprocess.run([sys.executable, '-c', export_code, str(first.resolve())],
                   cwd=out, check=True, timeout=60, capture_output=True)
    expected = (fixture / 'dense6-bga324.dsn').read_bytes()
    assert canonical_dsn((out / 'board.dsn').read_bytes()) == canonical_dsn(expected), 'exported DSN differs'
    reports = []
    for name, board in (('generated', first), ('bundled', reference)):
        report = out / (name + '-drc.json')
        subprocess.run(['kicad-cli', 'pcb', 'drc', '--format', 'json', '--severity-all',
                        '-o', str(report), str(board)], check=True, timeout=60, capture_output=True)
        data = json.loads(report.read_text())
        errors = [v for v in data['violations'] if v['severity'] == 'error']
        warnings = Counter(v['type'] for v in data['violations'] if v['severity'] == 'warning')
        assert not errors, f'{name}: native DRC errors'
        assert warnings == {'lib_footprint_issues': 30}, f'{name}: unexpected warnings: {warnings}'
        assert len(data['unconnected_items']) == 439, f'{name}: unexpected connection count'
        reports.append(dict(board=name, errors=0, opens=439, warnings=dict(warnings)))
    summary = dict(seed=6406, stats=stats, generator_sha256=hashlib.sha256(generator.read_bytes()).hexdigest(),
                   dsn_sha256=hashlib.sha256(expected).hexdigest(), deterministic=True,
                   geometry_equal=True, dsn_semantically_equal=True, reports=reports,
                   limitation='Unrouted candidate only; feasibility is unproven.')
    (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--generator', required=True, type=Path)
    parser.add_argument('--fixture', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path, help='new evidence directory')
    args = parser.parse_args()
    verify(args.generator.resolve(), args.fixture.resolve(), args.out.resolve())
