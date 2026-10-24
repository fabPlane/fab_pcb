# SPDX-License-Identifier: MIT
"""Measure report/input alias safety using disposable files and a failing checker."""
import argparse
import csv
import importlib.util
from pathlib import Path
import tempfile
import subprocess


def measure(audit, out):
    spec = importlib.util.spec_from_file_location('audit_under_test', audit)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    rows = []
    for repeat in range(1, 4):
        for target in ('board.kicad_pcb', 'board.kicad_pro', 'board.kicad_dru', 'cli'):
            for alias in ('direct', 'symlink', 'hardlink'):
                with tempfile.TemporaryDirectory(prefix='native-output-safety-') as temp:
                    root = Path(temp)
                    names = ('board.kicad_pcb', 'board.kicad_pro', 'board.kicad_dru', 'cli')
                    for name in names:
                        (root / name).write_text(name)
                    cli = root / 'cli'
                    cli.write_text('#!/bin/sh\nexit 1\n')
                    cli.chmod(0o755)
                    before = {name: (root / name).read_bytes() for name in names}
                    protected = root / target
                    output = protected if alias == 'direct' else root / 'report.json'
                    if alias == 'symlink':
                        output.symlink_to(protected)
                    elif alias == 'hardlink':
                        output.hardlink_to(protected)
                    rejected = False
                    try:
                        module.snapshot(root / 'board.kicad_pcb', output, str(cli))
                    except ValueError as error:
                        rejected = 'aliases' in str(error)
                    except (OSError, RuntimeError, subprocess.CalledProcessError):
                        pass
                    preserved = all((root / name).exists() and (root / name).read_bytes() == value
                                    for name, value in before.items())
                    rows.append(dict(repeat=repeat, target=target, alias=alias,
                                     rejected_before_check=int(rejected), inputs_preserved=int(preserved),
                                     destination_preserved=int(output.exists())))
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('w') as file:
        writer = csv.DictWriter(file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f'{sum(r["inputs_preserved"] for r in rows)}/{len(rows)} inputs preserved; '
          f'{sum(r["rejected_before_check"] for r in rows)}/{len(rows)} aliases rejected before check')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audit', type=Path, default=Path(__file__).with_name('audit.py'))
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    measure(args.audit, args.out)
