# SPDX-License-Identifier: MIT
"""Fresh native replay of six real sessions produced by measure.ts, no rerouting."""
import argparse
import csv
import json
from pathlib import Path
import shutil
import subprocess
import sys


def drc(board, report):
    subprocess.run(['kicad-cli', 'pcb', 'drc', '--severity-all', '--format', 'json',
                    '-o', str(report), str(board)], check=True, timeout=60,
                   stdout=subprocess.DEVNULL)
    data = json.loads(report.read_text())
    assert data['source'] == board.name
    assert {'error', 'warning'} <= set(data['included_severities'])
    assert data['coordinate_units'] == 'mm'
    findings = data['violations'] + data['schematic_parity']
    return dict(opens=len(data['unconnected_items']),
                errors=sum(f['severity'] == 'error' for f in findings),
                warnings=sum(f['severity'] == 'warning' for f in findings))


def verify(pcb, measure):
    pcb, measure = pcb.resolve(), measure.resolve()
    rows = json.loads((measure / 'native.json').read_text())
    assert len(rows) == 6
    initial = drc(pcb, measure / 'initial-drc.json')
    result = []
    for row in rows:
        session = Path(row['session'])
        target = session.with_suffix('.kicad_pcb')
        assert not target.exists()
        subprocess.run([sys.executable, __file__, '--import', str(pcb), str(session),
                        str(target)], check=True, timeout=30)
        for suffix in ('.kicad_pro', '.kicad_dru'):
            if pcb.with_suffix(suffix).exists():
                shutil.copyfile(pcb.with_suffix(suffix), target.with_suffix(suffix))
        quality = drc(target, session.with_suffix('.drc.json'))
        result.append(dict(repeat=row['repeat'], version=row['version'],
                           initial_opens=initial['opens'], **quality,
                           completion=max(0, 1-quality['opens']/initial['opens']) if initial['opens'] else float(quality['opens']==0)))
    for repeat in range(1, 4):
        pair = [r for r in result if r['repeat'] == repeat]
        assert len(pair) == 2
        assert {k:v for k,v in pair[0].items() if k != 'version'} == {k:v for k,v in pair[1].items() if k != 'version'}
        assert pair[0]['completion'] == 1 and pair[0]['errors'] == 0
    with (measure / 'native-quality.csv').open('w') as f:
        writer = csv.DictWriter(f, fieldnames=list(result[0]), lineterminator='\n')
        writer.writeheader(); writer.writerows(result)
    print('3 before/after native pairs: 100% completion, 0 opens, 0 native errors')


if __name__ == '__main__':
    if sys.argv[1:2] == ['--import']:
        import pcbnew
        board = pcbnew.LoadBoard(sys.argv[2])
        assert board is not None and pcbnew.ImportSpecctraSES(board, sys.argv[3])
        board.Save(sys.argv[4])
    else:
        p=argparse.ArgumentParser(description=__doc__)
        p.add_argument('--pcb', type=Path, required=True)
        p.add_argument('--measure', type=Path, required=True)
        a=p.parse_args(); verify(a.pcb, a.measure)
