# SPDX-License-Identifier: MIT
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import baseline
from audit import digest


class BaselineTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.board = self.root / 'input.kicad_pcb'
        self.output = self.root / 'routed.kicad_pcb'
        self.tool = self.root / 'checker'
        for p in (self.board, self.output, self.tool):
            p.write_text(p.name)
        self.patcher = patch('baseline.snapshot', side_effect=self.snapshot)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.evidence = baseline.capture(self.board, self.root / 'input.json', str(self.tool))

    def snapshot(self, board, report, cli):
        board, report = Path(board), Path(report)
        opens = 2 if board == self.board else 1
        findings = [dict(type='unconnected_items', severity='error',
                       items=[dict(uuid=str(i + edge), pos=dict(x=i + edge, y=0)) for i in range(2)])
                    for edge in range(opens)]
        report.write_text(json.dumps(dict(source=board.name, coordinate_units='mm',
              included_severities=['error', 'warning'], violations=[], schematic_parity=[],
              unconnected_items=findings)))
        return dict(opens=opens, errors=0, warnings=0, kicad_version='test',
                    report_sha256=digest(report), identity={str(p): digest(p) if p.exists() else None
                    for p in (board, board.with_suffix('.kicad_pro'), board.with_suffix('.kicad_dru'), Path(cli))})

    def test_roundtrip_scores_edges(self):
        restored = json.loads(json.dumps(self.evidence))
        result = baseline.score(restored, self.output, self.root / 'output.json', str(self.tool))
        self.assertEqual(result['completion_rate'], .5)
        self.assertEqual(result['initial_opens'], 2)
        self.assertEqual(result['baseline_id'], restored['baseline_id'])

    def test_changed_source_rules_tool_and_report_reject(self):
        for name in ('input.kicad_pcb', 'input.kicad_pro', 'input.kicad_dru', 'checker', 'input.json'):
            with self.subTest(name=name):
                path = self.root / name
                previous = path.read_bytes() if path.exists() else None
                path.write_text('changed')
                with self.assertRaises((ValueError, json.JSONDecodeError)):
                    baseline.score(self.evidence, self.output, self.root / 'output.json', str(self.tool))
                if previous is None:
                    path.unlink()
                else:
                    path.write_bytes(previous)

    def test_mismatched_routed_rules_reject(self):
        for suffix in ('.kicad_pro', '.kicad_dru'):
            with self.subTest(suffix=suffix):
                p = self.output.with_suffix(suffix)
                p.write_text('different rules')
                with self.assertRaisesRegex(ValueError, 'rules differ'):
                    baseline.score(self.evidence, self.output, self.root / 'output.json', str(self.tool))
                p.unlink()

    def test_serialized_count_changes_reject(self):
        changed = copy.deepcopy(self.evidence)
        changed['snapshot']['opens'] = 1
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            baseline.verify(changed)
        changed['baseline_id'] = baseline.fingerprint({k: v for k, v in changed.items() if k != 'baseline_id'})
        with self.assertRaisesRegex(ValueError, 'counts'):
            baseline.verify(changed)

    def test_routed_report_cannot_overwrite_baseline(self):
        for name in ('input.json', 'input.kicad_pcb', 'input.kicad_pro', 'input.kicad_dru', 'checker'):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'aliases baseline'):
                baseline.score(self.evidence, self.output, self.root / name, str(self.tool))
        baseline.verify(self.evidence)

    def test_mutation_during_routed_check_rejects(self):
        original = self.snapshot
        def mutate(*args):
            result = original(*args)
            self.board.write_text('changed during routed check')
            return result
        with patch('baseline.snapshot', side_effect=mutate), self.assertRaisesRegex(ValueError, 'changed'):
            baseline.score(self.evidence, self.output, self.root / 'output.json', str(self.tool))


if __name__ == '__main__':
    unittest.main()
