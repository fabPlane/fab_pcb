#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Run three paired fixture verifications and twelve constructed negative controls."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys


def measure(reference, candidate, generator, verifier, out):
    out.mkdir(parents=True, exist_ok=False)
    records = []
    for repeat in range(1, 4):
        for label, fixture in [('reference', reference), ('candidate', candidate)]:
            dest = out / f'{label}-{repeat}'
            result = subprocess.run([sys.executable, str(verifier), '--generator', str(generator),
                                     '--fixture', str(fixture), '--out', str(dest)],
                                    capture_output=True, text=True, timeout=90)
            (out / f'{label}-{repeat}.log').write_text(result.stdout + result.stderr)
            assert result.returncode == 0, result.stderr
            records.append(dict(label=label, repeat=repeat, exit=result.returncode,
                                summary=json.loads((dest / 'summary.json').read_text())))
        for mutation in ('rules', 'minima', 'geometry', 'dsn'):
            fixture = out / f'{mutation}-fixture-{repeat}'
            fixture.mkdir()
            for suffix in ('kicad_pcb', 'kicad_pro', 'dsn'):
                name = 'dense6-bga324.' + suffix
                shutil.copyfile(candidate / name, fixture / name)
            if mutation == 'rules':
                path = fixture / 'dense6-bga324.kicad_pro'
                data = json.loads(path.read_text())
                data['net_settings']['classes'][0]['clearance'] = 0.2
                path.write_text(json.dumps(data))
            elif mutation == 'minima':
                path = fixture / 'dense6-bga324.kicad_pro'
                data = json.loads(path.read_text())
                data['board']['design_settings']['rules']['min_clearance'] = 0.05
                path.write_text(json.dumps(data))
            elif mutation == 'geometry':
                path = fixture / 'dense6-bga324.kicad_pcb'
                text = path.read_text()
                assert '(at 32 28)' in text
                path.write_text(text.replace('(at 32 28)', '(at 33 28)', 1))
            else:
                path = fixture / 'dense6-bga324.dsn'
                text = path.read_text()
                assert '(width 100)' in text
                path.write_text(text.replace('(width 100)', '(width 101)', 1))
            result = subprocess.run([sys.executable, str(verifier), '--generator', str(generator),
                                     '--fixture', str(fixture), '--out', str(out / f'{mutation}-{repeat}')],
                                    capture_output=True, text=True, timeout=90)
            (out / f'{mutation}-{repeat}.log').write_text(result.stdout + result.stderr)
            reason = {'rules': 'wrong default rules', 'minima': 'wrong native rule minima', 'geometry': 'generated geometry differs',
                      'dsn': 'exported DSN differs'}[mutation]
            assert result.returncode != 0 and reason in result.stderr, result.stderr
            records.append(dict(label=mutation, repeat=repeat, exit=result.returncode, reason=reason))
    (out / 'controls.json').write_text(json.dumps(records, indent=2) + '\n')
    print('Valid fixtures retained: 6/6; constructed mutations rejected: 12/12')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('reference', 'candidate', 'generator', 'verifier', 'out'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    measure(*(getattr(args, key).resolve() for key in ('reference', 'candidate', 'generator', 'verifier', 'out')))
