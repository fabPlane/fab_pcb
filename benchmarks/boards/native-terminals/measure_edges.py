# SPDX-License-Identifier: MIT
"""Measure report-integrity rejection using fresh deterministic native reports."""
import argparse
import copy
import csv
import importlib.util
import json
from pathlib import Path
from audit import counts, snapshot, digest, completion
from generate_probes import generate


def measure(out, before_path, repeats):
    out.mkdir(parents=True, exist_ok=True)
    (out / 'summary.csv').unlink(missing_ok=True)
    spec = importlib.util.spec_from_file_location('before_audit', before_path)
    before = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(before)
    generate(out / 'inputs')
    rows, provenance = [], []
    for repeat in range(1, repeats + 1):
        for routed in range(3):
            board = out / 'inputs' / f't3-r{routed}.kicad_pcb'
            report_path = out / f'r{routed}-{repeat}.json'
            evidence = snapshot(board, report_path)
            native = json.loads(report_path.read_text())
            variants = {'native': copy.deepcopy(native), 'reordered': copy.deepcopy(native)}
            variants['reordered']['unconnected_items'].reverse()
            for edge in variants['reordered']['unconnected_items']:
                edge['items'].reverse()
            if native['unconnected_items']:
                for name in ('duplicate', 'reversed-duplicate', 'self-edge'):
                    changed = copy.deepcopy(native)
                    edge = copy.deepcopy(changed['unconnected_items'][0])
                    if name == 'reversed-duplicate':
                        edge['items'].reverse()
                    if name == 'self-edge':
                        edge['items'][1] = copy.deepcopy(edge['items'][0])
                    changed['unconnected_items'].append(edge)
                    variants[name] = changed
            for name, report in variants.items():
                expected = name in ('native', 'reordered')
                accepted = []
                parsed = []
                for parser in (before.counts, counts):
                    try:
                        parsed.append(parser(report, board))
                        accepted.append(True)
                    except ValueError:
                        parsed.append(None)
                        accepted.append(False)
                if accepted != [True, expected]:
                    raise ValueError(f'unexpected parser result {name}: {accepted}')
                if expected and parsed[0] != parsed[1]:
                    raise ValueError('valid native counts changed')
                apparent = completion(parsed[0]['opens'], evidence['opens'])
                rows.append(dict(case=f'r{routed}-{name}', repeat=repeat, valid=expected,
                    before_accepted=accepted[0], after_accepted=accepted[1],
                    actual_opens=evidence['opens'], reported_opens=parsed[0]['opens'],
                    unchanged_completion_before=apparent))
                provenance.append(dict(case=f'r{routed}-{name}', repeat=repeat,
                    native=evidence, tested_report=report))
    with (out / 'summary.csv').open('w') as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator='\n')
        writer.writeheader(); writer.writerows(rows)
    (out / 'provenance.json').write_text(json.dumps(dict(
        before_sha256=digest(before_path), after_sha256=digest(Path(__file__).with_name('audit.py')),
        repeats=repeats, measurements=provenance), indent=2) + '\n')
    print(f'{len(rows)} paired report checks; {3 * repeats} fresh native DRC runs')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--before', type=Path, required=True)
    p.add_argument('--repeats', type=int, choices=range(1, 11), default=3)
    args = p.parse_args()
    measure(args.out.resolve(), args.before.resolve(), args.repeats)
