#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Compare original/corrected native verifier under Python optimization."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys


def measure(before, after, generator, fixture, out):
    out.mkdir(parents=True, exist_ok=False)
    records = []
    for repeat in range(1, 4):
        for label in ('valid', 'rules', 'minima', 'geometry', 'dsn'):
            candidate = out / f'fixture-{label}-{repeat}'
            candidate.mkdir()
            for suffix in ('kicad_pcb', 'kicad_pro', 'dsn'):
                name = 'dense6-bga324.' + suffix
                shutil.copyfile(fixture / name, candidate / name)
            if label in ('rules', 'minima'):
                path = candidate / 'dense6-bga324.kicad_pro'
                data = json.loads(path.read_text())
                if label == 'rules':
                    data['net_settings']['classes'][0]['clearance'] = 0.2
                else:
                    data['board']['design_settings']['rules']['min_clearance'] = 0.05
                path.write_text(json.dumps(data))
            elif label in ('geometry', 'dsn'):
                path = candidate / ('dense6-bga324.kicad_pcb' if label == 'geometry' else 'dense6-bga324.dsn')
                old, new = ('(at 32 28)', '(at 33 28)') if label == 'geometry' else ('(width 100)', '(width 101)')
                text = path.read_text()
                if old not in text:
                    raise RuntimeError('Mutation target missing')
                path.write_text(text.replace(old, new, 1))
            for version, verifier in (('before', before), ('after', after)):
                dest = out / f'{version}-{label}-{repeat}'
                result = subprocess.run([sys.executable, '-O', str(verifier), '--generator', str(generator),
                                         '--fixture', str(candidate), '--out', str(dest)],
                                        capture_output=True, text=True, timeout=150)
                (out / f'{version}-{label}-{repeat}.log').write_text(result.stdout + result.stderr)
                expected_success = version == 'before' or label == 'valid'
                if (result.returncode == 0) != expected_success:
                    raise RuntimeError(f'Unexpected result: {version} {label}: {result.stderr}')
                reasons = dict(rules='wrong default rules', minima='wrong native rule minima',
                               geometry='generated geometry differs', dsn='exported DSN differs')
                if not expected_success and reasons[label] not in result.stderr:
                    raise RuntimeError(f'Unexpected rejection: {result.stderr}')
                records.append(dict(version=version, label=label, repeat=repeat, exit=result.returncode))
                (out / 'controls.json').write_text(json.dumps(records, indent=2) + '\n')
    print('Optimized verifier: invalid accepted 12/12 -> 0/12; valid retained 3/3 -> 3/3')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('before', 'after', 'generator', 'fixture', 'out'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    measure(*(getattr(args, key).resolve() for key in ('before', 'after', 'generator', 'fixture', 'out')))
