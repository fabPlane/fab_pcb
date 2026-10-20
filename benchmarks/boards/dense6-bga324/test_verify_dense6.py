# SPDX-License-Identifier: MIT
import copy
import json
import unittest
import subprocess
import sys
import tempfile
from pathlib import Path
from verify_dense6 import canonical_dsn, geometry, project_policy_digest, EXPECTED_POLICY_SHA256, require_no_custom_rules


class CanonicalDsnTests(unittest.TestCase):
    def test_optimized_python_keeps_evidence_gates(self):
        code = """
from verify_dense6 import canonical_dsn, require
for operation in (lambda: require(False, 'evidence rejected'),
                  lambda: canonical_dsn(b'(pcb board))'),
                  lambda: canonical_dsn(b'pcb board')):
    try:
        operation()
    except AssertionError:
        continue
    raise RuntimeError('evidence gate was bypassed')
"""
        result = subprocess.run([sys.executable, '-O', '-c', code],
                                cwd=Path(__file__).resolve().parent,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_reorders_unordered_pins_and_components(self):
        a = b'(pcb board (placement (component X (place A 1 2 front 0)) (component Y (place B 3 4 front 0))) (network (net N (pins A-1 B-1))))'
        b = b'(pcb board (placement (component Y (place B 3 4 front 0)) (component X (place A 1 2 front 0))) (network (net N (pins B-1 A-1))))'
        self.assertEqual(canonical_dsn(a), canonical_dsn(b))

    def test_preserves_path_coordinate_order(self):
        a = b'(pcb board (wiring (wire (path F.Cu 100 1 2 3 4))))'
        b = b'(pcb board (wiring (wire (path F.Cu 100 3 4 1 2))))'
        self.assertNotEqual(canonical_dsn(a), canonical_dsn(b))

    def test_preserves_duplicate_pins(self):
        self.assertNotEqual(canonical_dsn(b'(net N (pins A A B))'),
                            canonical_dsn(b'(net N (pins A B))'))

    def test_preserves_rule_values_and_net_owners(self):
        for a, b in [(b'(rule (width 100))', b'(rule (width 200))'),
                     (b'(net N (pins A B))', b'(net N (pins A C))')]:
            self.assertNotEqual(canonical_dsn(a), canonical_dsn(b))

    def test_rejects_unclosed_lists(self):
        for text in (b'(pcb board', b'(pcb board (network (net N (pins A B)))'):
            with self.assertRaises(ValueError):
                canonical_dsn(text)

    def test_rejects_trailing_forms(self):
        with self.assertRaises(AssertionError):
            canonical_dsn(b'(pcb board))')

    def test_preserves_quoted_tokens(self):
        self.assertNotEqual(canonical_dsn(b'(net "a b" (pins A B))'),
                            canonical_dsn(b'(net a b (pins A B))'))


class ProjectPolicyTests(unittest.TestCase):
    def test_external_rules_cannot_be_silently_discarded(self):
        with tempfile.TemporaryDirectory() as directory:
            board = Path(directory) / 'candidate.kicad_pcb'
            rules = board.with_suffix('.kicad_dru')
            require_no_custom_rules(board)
            for data in ('', '(version 1)\n(rule "relaxed" (constraint clearance (min 0.01mm)))\n'):
                rules.write_text(data)
                with self.assertRaisesRegex(AssertionError, 'unsupported custom rule sidecar'):
                    require_no_custom_rules(board)
                rules.unlink()
            rules.symlink_to(Path(directory) / 'absent')
            with self.assertRaisesRegex(AssertionError, 'unsupported custom rule sidecar'):
                require_no_custom_rules(board)
            rules.unlink()
            rules.mkdir()
            with self.assertRaisesRegex(AssertionError, 'unsupported custom rule sidecar'):
                require_no_custom_rules(board)

    def test_project_policy_pins_every_native_checking_field(self):
        fixture = Path(__file__).resolve().parents[2] / 'corpus/dense-candidate/dense6-bga324.kicad_pro'
        if not fixture.exists():
            fixture = Path(__file__).resolve().parent / 'dense6-bga324.kicad_pro'
        project = json.loads(fixture.read_text())
        self.assertEqual(project_policy_digest(project), EXPECTED_POLICY_SHA256)
        # Every rule and severity, including currently unused microvia rules,
        # belongs to the contract even when an unrouted DRC has no such item.
        for group in ('rules', 'rule_severities'):
            for key, value in project['board']['design_settings'][group].items():
                altered = copy.deepcopy(project)
                altered['board']['design_settings'][group][key] = (
                    not value if isinstance(value, bool) else
                    value + 0.01 if isinstance(value, (int, float)) else
                    'ignore' if value != 'ignore' else 'error')
                self.assertNotEqual(project_policy_digest(altered), EXPECTED_POLICY_SHA256, (group, key))
        for field, value in [('drc_exclusions', ['unexpected exclusion']),
                             ('rules', {}), ('rule_severities', {})]:
            altered = copy.deepcopy(project)
            altered['board']['design_settings'][field] = value
            self.assertNotEqual(project_policy_digest(altered), EXPECTED_POLICY_SHA256, field)
        altered = copy.deepcopy(project)
        altered['net_settings']['classes'][0]['clearance'] = 0.05
        self.assertNotEqual(project_policy_digest(altered), EXPECTED_POLICY_SHA256)
        altered = copy.deepcopy(project)
        altered['net_settings']['netclass_patterns'] = [{'netclass': 'Default', 'pattern': '*'}]
        self.assertNotEqual(project_policy_digest(altered), EXPECTED_POLICY_SHA256)
        # JSON formatting/key order and UI state do not change checking policy.
        project['pcbnew']['last_paths']['specctra_dsn'] = '/tmp/another-export'
        self.assertEqual(project_policy_digest(project), EXPECTED_POLICY_SHA256)
        self.assertEqual(project_policy_digest(json.loads(json.dumps(project, sort_keys=True))),
                         EXPECTED_POLICY_SHA256)


class NativeClearanceTests(unittest.TestCase):
    def test_footprint_copper_graphics_cannot_bypass_candidate_signature(self):
        try:
            import pcbnew
        except ImportError:
            self.skipTest("requires KiCad pcbnew")
        board = pcbnew.BOARD()
        footprint = pcbnew.FOOTPRINT(board)
        footprint.SetReference("J1")
        board.Add(footprint)
        original = geometry(board)
        for layer in (pcbnew.F_Cu, pcbnew.B_Cu, pcbnew.F_SilkS):
            graphic = pcbnew.PCB_SHAPE(footprint)
            graphic.SetShape(pcbnew.SHAPE_T_SEGMENT)
            graphic.SetLayer(layer)
            graphic.SetStart(pcbnew.VECTOR2I(1000000, 1000000))
            graphic.SetEnd(pcbnew.VECTOR2I(2000000, 1000000))
            graphic.SetWidth(100000)
            footprint.Add(graphic)
            self.assertEqual(len(board.GetDrawings()), 0)
            with self.assertRaisesRegex(AssertionError, 'unsupported native footprint graphics'):
                geometry(board)
            footprint.Remove(graphic)
            self.assertEqual(original, geometry(board))

    def test_footprint_rule_areas_cannot_bypass_candidate_signature(self):
        try:
            import pcbnew
        except ImportError:
            self.skipTest("requires KiCad pcbnew")
        board = pcbnew.BOARD()
        footprint = pcbnew.FOOTPRINT(board)
        footprint.SetReference("J1")
        board.Add(footprint)
        geometry(board)
        zone = pcbnew.ZONE(footprint)
        zone.SetIsRuleArea(True)
        zone.SetDoNotAllowTracks(True)
        footprint.Add(zone)
        self.assertEqual(len(board.Zones()), 0)
        self.assertEqual(len(footprint.Zones()), 1)
        with self.assertRaisesRegex(AssertionError, 'unsupported native footprint zones'):
            geometry(board)

    def test_net_tie_exemptions_cannot_change_candidate_rules(self):
        try:
            import pcbnew
        except ImportError:
            self.skipTest("requires KiCad pcbnew")
        board = pcbnew.BOARD()
        footprint = pcbnew.FOOTPRINT(board)
        footprint.SetReference("J1")
        for number in ("1", "2"):
            pad = pcbnew.PAD(footprint)
            pad.SetNumber(number)
            footprint.Add(pad)
        board.Add(footprint)
        original = geometry(board)
        footprint.AddNetTiePadGroup("1,2")
        with self.assertRaisesRegex(AssertionError, 'unsupported native net-tie groups'):
            geometry(board)
        footprint.ClearNetTiePadGroups()
        self.assertEqual(original, geometry(board))


    def test_local_clearance_overrides_change_native_signature(self):
        try:
            import pcbnew
        except ImportError:
            self.skipTest("requires KiCad pcbnew")
        # An unset override and explicit zero have different rule inheritance.
        for owner in ("pad", "footprint"):
            board = pcbnew.BOARD()
            footprint = pcbnew.FOOTPRINT(board)
            footprint.SetReference("U1")
            pad = pcbnew.PAD(footprint)
            pad.SetNumber("1")
            footprint.Add(pad)
            board.Add(footprint)
            item = pad if owner == "pad" else footprint
            original = geometry(board)
            self.assertIsNone(item.GetLocalClearance())
            observed = []
            for clearance in (0, 50000, 100000):
                item.SetLocalClearance(clearance)
                signature = geometry(board)
                self.assertNotEqual(original, signature, (owner, clearance))
                self.assertNotIn(signature, observed)
                observed.append(signature)
            item.SetLocalClearance(None)
            self.assertEqual(original, geometry(board))


if __name__ == '__main__':
    unittest.main()
