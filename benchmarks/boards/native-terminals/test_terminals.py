# SPDX-License-Identifier: MIT
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from generate_probes import generate
from measure import fixtures
from terminals import assert_preserved, guarded_score, signature


class TerminalTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.original, self.cases = fixtures(self.root)

    def test_real_mutations_fail_and_routing_serialization_pass(self):
        supported = {'unchanged', 'partial-route', 'complete-route', 'reserialized'}
        for name, board in self.cases:
            with self.subTest(name=name):
                if name in supported:
                    self.assertEqual(len(assert_preserved(self.original, board)), 64)
                else:
                    with self.assertRaisesRegex(ValueError, 'terminal'):
                        assert_preserved(self.original, board)

    def test_net_code_and_object_order_do_not_change_terminal_identity(self):
        text = self.original.read_text().replace('(net 1 ', '(net 7 ')
        lines = text.splitlines()
        indices = [i for i, line in enumerate(lines) if line.startswith('(footprint')]
        footprints = [lines[i] for i in indices][::-1]
        for i, footprint in zip(indices, footprints):
            lines[i] = footprint
        reordered = self.root / 'reordered.kicad_pcb'
        reordered.write_text('\n'.join(lines) + '\n')
        self.assertEqual(len(assert_preserved(self.original, reordered)), 64)

    def test_unsupported_pad_geometry_fails_closed(self):
        import pcbnew
        for method, value in [('GetShape', pcbnew.PAD_SHAPE_CUSTOM)]:
            with patch.object(pcbnew.PAD, method, return_value=value):
                with self.assertRaisesRegex(ValueError, 'custom pad'):
                    signature(self.original)
        with patch.object(pcbnew.PADSTACK, 'Mode', return_value=pcbnew.PADSTACK.MODE_CUSTOM):
            with self.assertRaisesRegex(ValueError, 'nonuniform'):
                signature(self.original)

    def test_duplicate_pads_are_preserved_as_a_multiset(self):
        duplicate = dict(self.cases)['duplicate-terminal']
        self.assertEqual(len(signature(duplicate)['pads']), 4)
        self.assertEqual(len(signature(self.original)['pads']), 3)

    def test_rejects_before_invoking_native_scorer(self):
        baseline = dict(board=str(self.original))
        with patch('terminals.verify'), patch('terminals.score') as score:
            with self.assertRaisesRegex(ValueError, 'terminal'):
                guarded_score(baseline, dict(self.cases)['remove-terminal'], self.root / 'report.json')
            score.assert_not_called()
            self.assertFalse((self.root / 'report.json').exists())

    def test_rechecks_terminal_identity_after_scoring(self):
        with patch('terminals.verify'), patch('terminals.score', return_value={}), \
             patch('terminals.assert_preserved', side_effect=['before', 'after']):
            with self.assertRaisesRegex(ValueError, 'during scoring'):
                guarded_score(dict(board=str(self.original)), self.original, self.root / 'report.json')

    def test_copper_stack_and_net_table_changes_reject(self):
        original = signature(self.original)
        for key in ('nets', 'copper_layers'):
            changed = copy.deepcopy(original)
            changed[key].append('changed')
            with self.subTest(key=key), patch('terminals.signature', side_effect=[original, changed]):
                with self.assertRaisesRegex(ValueError, 'terminal'):
                    assert_preserved(self.original, self.original)


if __name__ == '__main__':
    unittest.main()
