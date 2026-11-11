# SPDX-License-Identifier: MIT
"""Replay old/new report checks on fresh native reports and controlled mutations.

Run validate.py first, then this script REPORT_DIR OUTPUT_CSV. Output contains
one row per report and mutation, retaining all rejection/acceptance decisions.
"""
import csv
import json
from pathlib import Path
import sys

from report_audit import validate_report
from test_report_audit import mutations
from validate import ROOT, geometry


def old_check(report, pads):
    if report['violations'] != [] or report['schematic_parity'] != [] or len(report['unconnected_items']) != 100:
        raise ValueError('legacy report check failed')


def accepted(check, report, pads):
    try:
        check(report, pads)
        return 1
    except (ValueError, KeyError, TypeError):
        return 0


def main():
    reports, output = map(Path, sys.argv[1:])
    specs = json.loads((ROOT / 'manifest.json').read_text())['boards']
    pads = {s['tier']: geometry(ROOT, s)[2] for s in specs}
    summaries = list(csv.DictReader((reports / 'summary.csv').open()))
    rows = []
    for summary in summaries:
        tier = summary['tier']
        name = f"{summary['phase']}-{tier}-{summary['repeat']}.json"
        original = json.loads((reports / name).read_text())
        for label, change in [('valid', lambda report: None), *mutations().items()]:
            report = json.loads(json.dumps(original))
            change(report)
            before = accepted(old_check, report, pads[tier])
            after = accepted(validate_report, report, pads[tier])
            if after != int(label == 'valid'):
                raise ValueError(f'{name}: unexpected new decision for {label}')
            rows.append([name, label, before, after])
    with output.open('w', newline='') as stream:
        writer = csv.writer(stream, lineterminator='\n')
        writer.writerow(['report', 'variant', 'accepted_before', 'accepted_after'])
        writer.writerows(rows)
    print(f'Replayed {len(rows)} report decisions from {len(summaries)} native checks.')


if __name__ == '__main__':
    main()
