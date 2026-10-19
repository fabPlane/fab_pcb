# SPDX-License-Identifier: MIT
import unittest
from verify_dense6 import canonical_dsn


class CanonicalDsnTests(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
