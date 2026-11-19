#!/usr/bin/env python3
"""Check study-score reproduction, partial-run labeling, and frozen fixture tamper detection."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import benchmark
from report import calculate, report

ROOT = Path(__file__).resolve().parent


class BenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.suite = json.loads((ROOT / 'suite.json').read_text())
        self.rows = [dict(r, seconds=r['historical_seconds'], status='checked',
                         evidence='archived/' + r['router'])
                     for r in json.loads((ROOT / 'baselines.json').read_text())]
        self.controls = dict(routers=self.suite['routers'], cases=self.suite['cases'], seeds=[1, 2, 3],
                             complete=True, full_suite=True, smoke=False, order=self.rows)

    def test_reproduces_published_390_run_ranking(self):
        result = calculate(self.suite, self.rows, self.controls)
        actual = {r['id']: (r['valid_cases'], r['efficient'], r['fast']) for r in result['routers']}
        self.assertEqual(actual, {'kicad-routing-tools': (20, 70, 32), 'tracemaker': (18, 87, 30),
                                 'fastroute': (16, 91, 98), 'fab-router': (13, 66, 93),
                                 'freerouting': (12, 95, 21)})

    def test_one_repeat_cannot_receive_three_repeat_score(self):
        rows = [r for r in self.rows if r['seed'] == 1]
        controls = dict(self.controls, seeds=[1], smoke=True, full_suite=False, order=rows)
        result = calculate(self.suite, rows, controls)
        self.assertTrue(all(r['valid_cases'] == 0 and r['efficient'] is None for r in result['routers']))

    def test_missing_repeat_prevents_case_validity(self):
        row = next(r for r in self.rows if r['router'] == 'kicad-routing-tools' and r['passed'])
        rows = [r for r in self.rows if r is not row]
        result = calculate(self.suite, rows, dict(self.controls, complete=False))
        krt = next(r for r in result['routers'] if r['id'] == 'kicad-routing-tools')
        self.assertEqual(krt['valid_cases'], 19)

    def test_tampered_fixture_refused_before_engine_start(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'inputs.sha256.json').write_text(json.dumps({'fixture': 'unchanged'}))
            (root / 'fixture').write_text('tampered')
            with patch.object(benchmark, 'ROOT', root):
                with self.assertRaisesRegex(RuntimeError, 'Frozen benchmark input changed'):
                    benchmark.verify()

    def test_report_can_be_generated_without_routers(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            report(out, self.suite, self.rows, self.controls, render=False)
            self.assertTrue((out / 'report.html').is_file())
            self.assertEqual(json.loads((out / 'summary.json').read_text())['completed_runs'], 390)
            self.assertNotIn('__DATA__', (out / 'report.html').read_text())


if __name__ == '__main__':
    unittest.main()
