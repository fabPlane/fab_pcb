# SPDX-License-Identifier: MIT
import copy
import json
import sys
import importlib.util
import unittest
from pathlib import Path

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('bga1296', Path(__file__).resolve().parent/'generate.py')
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)

class ReportAdmission(unittest.TestCase):
    def report(self):
        return {'$schema': 'https://schemas.kicad.org/drc.v1.json', 'source': 'bga1296.kicad_pcb',
                'kicad_version': '10.0.6', 'included_severities': ['error', 'warning', 'exclusion'],
                'violations': [], 'schematic_parity': [],
                'unconnected_items': [{'type': 'unconnected_items', 'severity': 'error'} for _ in range(499)]}

    def test_explicit_limited_diagnostic_is_admitted(self):
        generator.validate_report(self.report(), 1296, 'bga1296.kicad_pcb')

    def test_unqualified_reports_reject(self):
        mutations = [
            ('schematic_parity', [{'type': 'footprint_type_mismatch', 'severity': 'warning'}]),
            ('violations', [{'type': 'clearance', 'severity': 'error'}]),
            ('source', 'other.kicad_pcb'), ('$schema', 'unknown'), ('kicad_version', ''),
            ('included_severities', ['error']), ('included_severities', None), ('included_severities', [{}]),
            ('unconnected_items', [None]*499), ('unconnected_items', []),
            ('unconnected_items', [{'type': 'clearance', 'severity': 'error'}]*499),
            ('unconnected_items', [{'type': 'unconnected_items', 'severity': 'warning'}]*499),
        ]
        for key, value in mutations:
            with self.subTest(key=key, value=str(value)[:80]):
                data = self.report(); data[key] = value
                with self.assertRaises(RuntimeError):
                    generator.validate_report(data, 1296, 'bga1296.kicad_pcb')
        for key in ('violations', 'schematic_parity', 'unconnected_items'):
            with self.subTest(missing=key):
                data = self.report(); del data[key]
                with self.assertRaises(RuntimeError):
                    generator.validate_report(data, 1296, 'bga1296.kicad_pcb')

def measure(directory):
    destination = Path(directory).resolve()
    destination.mkdir(parents=True, exist_ok=False)
    rows = []
    for repeat in range(3):
        output = destination / f'qualified-{repeat}'
        summary = generator.generate(output)
        data = json.loads((output / 'drc.json').read_text())
        cases = {'valid': data}
        for section in ('violations', 'schematic_parity', 'unconnected_items'):
            mutated = copy.deepcopy(data)
            del mutated[section]
            cases['missing-' + section] = mutated
        for name, key, value in [
            ('parity', 'schematic_parity', [{'type': 'footprint_type_mismatch', 'severity': 'warning'}]),
            ('wrong-board', 'source', 'other.kicad_pcb'),
            ('wrong-schema', '$schema', 'unknown'),
            ('no-version', 'kicad_version', ''),
            ('error-only', 'included_severities', ['error']),
            ('null-opens', 'unconnected_items', [None] * 499),
            ('wrong-type', 'unconnected_items', [{'type': 'clearance', 'severity': 'error'}] * 499),
            ('excluded-opens', 'unconnected_items', [{'type': 'unconnected_items', 'severity': 'exclusion'}] * 499),
        ]:
            mutated = copy.deepcopy(data)
            mutated[key] = value
            cases[name] = mutated
        for name, report in cases.items():
            for implementation in ('before', 'after'):
                try:
                    if implementation == 'before':
                        # Previous generator's admission condition, retained for paired controls.
                        if report['violations'] or len(report['unconnected_items']) != 499:
                            raise RuntimeError('unexpected DRC')
                    else:
                        generator.validate_report(report, 1296, 'bga1296.kicad_pcb')
                    accepted = True
                except (RuntimeError, KeyError):
                    accepted = False
                rows.append(dict(repeat=repeat, case=name, implementation=implementation, accepted=accepted))
                if implementation == 'after' and accepted != (name == 'valid'):
                    raise RuntimeError('admission mismatch')
    result = dict(repeats=3, fresh_drc_reports=3, control_executions=len(rows),
                  artifact_sha256=summary['sha256'], rows=rows)
    (destination / 'report-controls.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    unittest.main()
