# SPDX-License-Identifier: MIT
"""Compare direct native session commands with the guarded offline runner."""
import argparse
import csv
from pathlib import Path
import subprocess
import sys
from audit import completion, snapshot
from generate_probes import generate
from route import run


def measure(out, command, repeats):
    out.mkdir(parents=True, exist_ok=False)
    generate(out / 'inputs')
    original = out / 'inputs/t3-r0.kicad_pcb'
    wrapper = str(Path(__file__).with_name('session_command.py').resolve())
    rows = []
    for repeat in range(1, repeats + 1):
        initial = snapshot(original, out / f'initial-{repeat}.json')
        before_dir = out / f'before-{repeat}'
        before_dir.mkdir()
        target = before_dir / 'board.kicad_pcb'
        with (before_dir / 'command.log').open('wb') as log:
            subprocess.run(['timeout', '--kill-after=2', '30', sys.executable, wrapper,
                            str(original), str(target), '--', *command],
                           stdout=log, stderr=subprocess.STDOUT, check=True)
        native = snapshot(target, before_dir / 'drc.json')
        after = run(original, out / f'after-{repeat}',
                    [sys.executable, wrapper, '{input}', '{output}', '--', *command], timeout=30)
        if after['state'] != 'completed':
            raise ValueError(f'guarded session command failed: {after}')
        quality = after['quality']
        before_rate = completion(initial['opens'], native['opens'])
        if before_rate != quality['completion_rate'] or native['errors'] != quality['native_errors']:
            raise ValueError('direct and guarded session quality differ')
        rows.append(dict(repeat=repeat, initial_opens=initial['opens'],
                         before_completion=before_rate, after_completion=quality['completion_rate'],
                         before_opens=native['opens'], after_opens=quality['remaining_opens'],
                         before_errors=native['errors'], after_errors=quality['native_errors']))
    with (out / 'summary.csv').open('w') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]), lineterminator='\n')
        writer.writeheader(); writer.writerows(rows)
    print(f'{len(rows)} direct/guarded native command pairs; identical completion and errors')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--repeats', type=int, default=3, choices=range(1, 11))
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('an engine command is required')
    measure(args.out.resolve(), command, args.repeats)
