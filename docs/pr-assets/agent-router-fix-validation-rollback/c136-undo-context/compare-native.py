#!/usr/bin/env python3
"""Compare complete native fab_router runs without changing benchmark scoring."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics


def load(path):
    controls = json.loads((path / 'controls.json').read_text())
    summary = json.loads((path / 'summary.json').read_text())
    assert summary['complete'] and summary['controls_preserved'] and not summary['smoke']
    rows = [r for r in json.loads((path / 'results.json').read_text()) if r['router'] == 'fab-router']
    keyed = {(r['case'], r['seed']): r for r in rows}
    assert len(rows) == len(keyed) == 78
    assert len({r['case'] for r in rows}) == 26
    assert all({seed for case, seed in keyed if case == name} == {1, 2, 3}
               for name, _ in keyed)
    assert all(r['status'] == 'checked' and r['check']['integrity_pass'] for r in rows)
    return controls, keyed


def metrics(rows):
    return dict(runs=len(rows), passed=sum(r['passed'] for r in rows.values()),
                valid_cases=sum(all(rows[name, seed]['passed'] for seed in (1, 2, 3))
                                for name in sorted({name for name, _ in rows})),
                opens=sum(r['opens'] for r in rows.values()),
                new_errors=sum(r['new_errors'] for r in rows.values()),
                median_seconds=statistics.median(r['seconds'] for r in rows.values()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--after', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    before_controls, before = load(args.before)
    after_controls, after = load(args.after)
    assert before.keys() == after.keys()
    for key in ('inputs_sha256', 'harness_sha256', 'runtime_sha256', 'runtime_source_sha256'):
        assert before_controls[key] == after_controls[key], key
    # Configs record absolute checkout paths. Verify recorded bytes first, then
    # normalize only the two known repository roots; settings/options stay exact.
    configs = []
    for path, controls, root in ((args.before, before_controls, '/home/hyper/bench/wt/fp-bugs/'),
                                 (args.after, after_controls, '/home/hyper/bench/wt/fp-bugs/')):
        data = (path / 'configs/fab-router.json').read_bytes()
        assert hashlib.sha256(data).hexdigest() == controls['configs_sha256']['fab-router.json']
        configs.append(json.loads(data.decode().replace(root, '$REPO/')))
    assert configs[0] == configs[1], 'router config differs after checkout-root normalization'
    reference = before_controls['runtime_source_sha256']
    for name, digest in after_controls['candidate']['source_sha256'].items():
        if name.startswith(('src/', 'types/')) and name.endswith('.ts'):
            assert reference['runtime/c/fab-router-source/' + name] == digest, name
    fields = ('passed', 'opens', 'new_errors', 'new_error_types', 'failed_fidelity', 'vias', 'length_mm')
    changed = [dict(case=case, seed=seed, fields=[key for key in fields if before[case, seed][key] != after[case, seed][key]])
               for case, seed in sorted(before)
               if any(before[case, seed][key] != after[case, seed][key] for key in fields)]
    cases = []
    for case in sorted({name for name, _ in after}):
        rows = [after[case, seed] for seed in (1, 2, 3)]
        cases.append(dict(case=case, passed=sum(r['passed'] for r in rows),
                          opens=[r['opens'] for r in rows],
                          new_errors=[r['new_errors'] for r in rows],
                          error_types=[r['new_error_types'] for r in rows],
                          thermal_items=[e for e in rows[0]['check']['new_error_details']
                                         if e['type'] == 'starved_thermal']))
    hashes = {label: {name: hashlib.sha256((path / name).read_bytes()).hexdigest()
                      for name in ('controls.json', 'results.json', 'summary.json')}
              for label, path in (('before', args.before), ('after', args.after))}
    report = dict(adapter_fix_exercised=False, before=metrics(before), after=metrics(after),
                  changed=changed, cases=cases, evidence_sha256=hashes,
                  before_cpus=before_controls['allowed_cpus'], after_cpus=after_controls['allowed_cpus'],
                  candidate_commit=after_controls['candidate']['commit'])
    args.out.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ('before', 'after', 'changed')}, indent=2))


if __name__ == '__main__':
    main()
