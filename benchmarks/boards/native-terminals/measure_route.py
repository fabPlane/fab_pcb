# SPDX-License-Identifier: MIT
"""Measure the offline command boundary against an unguarded command consumer.

Commands are deterministic test controls, not router performance measurements.
"""
import argparse
import csv
import json
from pathlib import Path
import subprocess
import sys
from audit import completion, snapshot
from generate_probes import generate
from route import run


def measure(out, repeats):
    out.mkdir(parents=True, exist_ok=False)
    generate(out / 'inputs')
    original = out / 'inputs/t3-r0.kicad_pcb'
    partial = out / 'inputs/t3-r1.kicad_pcb'
    complete = out / 'inputs/t3-r2.kicad_pcb'
    copy = lambda p: f'import shutil,sys; shutil.copyfile({str(p)!r},sys.argv[2])'
    cases = {
        'unchanged': (copy(original), True, 0),
        'partial-route': (copy(partial), True, .5),
        'complete-route': (copy(complete), True, 1),
        'failed-with-output': (copy(partial) + '; sys.exit(2)', False, None),
        'missing-output': ('pass', False, None),
        'aliased-output': ('import os,sys; os.link(sys.argv[1],sys.argv[2])', False, None),
        'changed-input': ("import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.write_text(p.read_text()+'\\n'); " + copy(partial), False, None),
        'changed-terminal': ("import pathlib,sys; p=pathlib.Path(sys.argv[1]); pathlib.Path(sys.argv[2]).write_text(p.read_text().replace('(at 30 10)', '(at 31 10)'))", False, None),
    }
    rows = []
    for repeat in range(1, repeats + 1):
        initial = snapshot(original, out / f'initial-{repeat}.json')
        for name, (code, valid, rate) in cases.items():
            # Explicit countermodel: a consumer reuses output and ignores exit
            # status and input preservation. Do not attribute this to any engine.
            before_dir = out / f'before-{name}-{repeat}'
            before_dir.mkdir()
            source, target = before_dir / 'input.kicad_pcb', before_dir / 'output.kicad_pcb'
            source.write_bytes(original.read_bytes())
            target.write_bytes(partial.read_bytes())
            if name == 'aliased-output':
                target.unlink()
            result = subprocess.run([sys.executable, '-c', code, str(source), str(target)],
                                    capture_output=True, timeout=10)
            native = snapshot(target, before_dir / 'drc.json')
            after = run(original, out / f'after-{name}-{repeat}',
                        [sys.executable, '-c', code, '{input}', '{output}'], timeout=10)
            accepted = after['state'] == 'completed'
            if accepted != valid or (valid and after['quality']['completion_rate'] != rate):
                raise ValueError(f'unexpected command outcome: {name}: {after}')
            rows.append(dict(case=name, repeat=repeat, valid=valid,
                             command_exit=result.returncode, before_accepted=True,
                             after_accepted=accepted,
                             before_completion=completion(initial['opens'], native['opens']),
                             after_completion=after.get('quality', {}).get('completion_rate', ''),
                             after_state=after['state']))
    with (out / 'summary.csv').open('w') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]), lineterminator='\n')
        writer.writeheader(); writer.writerows(rows)
    print(json.dumps(dict(pairs=len(rows), valid=sum(r['valid'] for r in rows),
                          invalid_accepted=sum(r['after_accepted'] for r in rows if not r['valid']))))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--repeats', type=int, default=3, choices=range(1, 11))
    args = parser.parse_args()
    measure(args.out.resolve(), args.repeats)
