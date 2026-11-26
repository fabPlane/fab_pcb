# SPDX-License-Identifier: MIT
"""Compare geometry validators on identical real fixtures and added nested SRJ fields.

--before is an earlier validate.py extracted with git show. Three repeats are
used per B1/B2 fixture and variant. No native DRC or routing is timed here.
"""
import argparse
import csv
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile

from validate import ROOT, geometry
from schema_variants import nested_variants


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('previous_validator', args.before)
    old = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(old)
    specs = json.loads((ROOT / 'manifest.json').read_text())['boards']
    rows = []
    with tempfile.TemporaryDirectory(prefix='bga-schema-measure-') as temp:
        source = Path(temp)
        for board in specs:
            tier = board['tier']
            shutil.copytree(ROOT / tier, source / tier)
            target = source / tier / 'unrouted.srj.json'
            original = json.loads(target.read_text())
            for variant, changed in [('valid', original), *nested_variants(original)]:
                target.write_text(json.dumps(changed))
                for repeat in range(1, 4):
                    decisions = []
                    for check in [old.geometry, geometry]:
                        try:
                            check(source, board)
                            decisions.append(1)
                        except ValueError:
                            decisions.append(0)
                    if decisions[1] != int(variant == 'valid'):
                        raise ValueError(f'{tier}/{variant}: unexpected new decision')
                    rows.append([tier, variant, repeat, *decisions])
    with args.out.open('w', newline='') as stream:
        writer = csv.writer(stream, lineterminator='\n')
        writer.writerow(['tier', 'variant', 'repeat', 'accepted_before', 'accepted_after'])
        writer.writerows(rows)
    print(f'Compared {len(rows)} same-fixture schema decisions.')


if __name__ == '__main__':
    main()
