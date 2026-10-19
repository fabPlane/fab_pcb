# SPDX-License-Identifier: MIT
"""Measure false native completion after terminal loss or reassignment."""
import argparse
import csv
import json
from pathlib import Path
from audit import digest
from baseline import capture, score
from generate_probes import generate
from terminals import guarded_score, assert_preserved


def fixtures(out):
    generate(out)
    original = out / 't3-r0.kicad_pcb'
    cases = [('unchanged', original), ('partial-route', out / 't3-r1.kicad_pcb'),
             ('complete-route', out / 't3-r2.kicad_pcb')]
    text = original.read_text()
    terminal = next(line for line in text.splitlines(keepends=True) if '"J3"' in line)
    mutations = {
        'remove-terminal': '',
        'disconnect-terminal': terminal.replace('(net 1 "N1")', '(net 0 "")'),
        'move-terminal': terminal.replace('(at 30 10)', '(at 30 12)'),
        'resize-terminal': terminal.replace('(size 1 1)', '(size 2 1)'),
        'rename-terminal': terminal.replace('(pad "1"', '(pad "2"'),
        'duplicate-terminal': terminal + terminal,
        'change-layer': terminal.replace('(layers "F.Cu")', '(layers "B.Cu")'),
    }
    for name, replacement in mutations.items():
        path = out / f'{name}.kicad_pcb'
        path.write_text(text.replace(terminal, replacement))
        cases.append((name, path))
    # Exercise a genuine native editor serialization in a separate process.
    import subprocess
    import sys
    path = out / 'reserialized.kicad_pcb'
    subprocess.run([sys.executable, '-c',
                    'import pcbnew,sys; b=pcbnew.LoadBoard(sys.argv[1]); b.Save(sys.argv[2])',
                    str(original), str(path)], check=True, timeout=30, capture_output=True)
    path.with_suffix('.kicad_pro').unlink(missing_ok=True)
    path.with_suffix('.kicad_prl').unlink(missing_ok=True)
    cases.append(('reserialized', path))
    return original, cases


def measure(out, repeats):
    out.mkdir(parents=True, exist_ok=True)
    (out / 'summary.csv').unlink(missing_ok=True)
    original, cases = fixtures(out / 'inputs')
    rows, provenance = [], []
    for repeat in range(1, repeats + 1):
        baseline = capture(original, out / f'input-{repeat}.json')
        for name, routed in cases:
            stem = out / f'{name}-{repeat}'
            before = score(baseline, routed, stem.with_suffix('.before.json'))
            try:
                after = guarded_score(baseline, routed, stem.with_suffix('.after.json'))
                accepted = True
            except ValueError as error:
                after = dict(error=str(error))
                accepted = False
            expected = name in ('unchanged', 'partial-route', 'complete-route', 'reserialized')
            expected_rate = {'unchanged': 0.0, 'partial-route': 0.5,
                             'complete-route': 1.0, 'reserialized': 0.0}.get(name)
            if expected and (before['completion_rate'] != expected_rate or
                             after.get('completion_rate') != expected_rate):
                raise ValueError(f'unexpected valid completion for {name}')
            if name in ('remove-terminal', 'disconnect-terminal') and before['completion_rate'] != 0.5:
                raise ValueError('missing expected false completion gain')
            if accepted != expected:
                raise ValueError(f'unexpected acceptance for {name}: {after}')
            rows.append(dict(case=name, repeat=repeat, before_accepted=True, after_accepted=accepted,
                             before_completion=before['completion_rate'],
                             after_completion=after.get('completion_rate', ''),
                             remaining_opens=before['remaining_opens'], native_errors=before['native_errors']))
            provenance.append(dict(case=name, repeat=repeat, board_sha256=digest(routed),
                                   baseline=baseline, before=before, after=after))
    with (out / 'summary.csv').open('w') as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator='\n')
        writer.writeheader(); writer.writerows(rows)
    (out / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print(f'{len(rows)} before/after pairs; invalid accepted {sum(r["after_accepted"] for r in rows if r["case"] not in ("unchanged","partial-route","complete-route","reserialized"))}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--repeats', type=int, default=3, choices=range(1, 11))
    args = parser.parse_args()
    measure(args.out.resolve(), args.repeats)
