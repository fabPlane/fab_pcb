# SPDX-License-Identifier: MIT
import unittest
from repeat_identity import single_identity, batch_identities


class RepeatIdentityTests(unittest.TestCase):
    def test_reordered_objects_are_identical(self):
        self.assertEqual(single_identity([{'a': 1, 'b': 2}, {'b': 2, 'a': 1}] * 2, 'fixture'),
                         '{"a": 1, "b": 2}')

    def test_mixed_values_rejected(self):
        for values in ([1, 1, 2], ['cpu-a', 'cpu-b', 'cpu-a'],
                       [{'hash': 'a'}, {'hash': 'b'}, {'hash': 'a'}], []):
            with self.subTest(values=values), self.assertRaises(ValueError):
                single_identity(values, 'identity')

    def test_batch_fixture_consistency_and_independent_fixtures(self):
        a = {'fixture': {'id': 'a', 'hash': 'one'}, 'system': {'cpu_name': 'cpu'}}
        b = {'fixture': {'id': 'b', 'hash': 'two'}, 'system': {'cpu_name': 'cpu'}}
        batch_identities([a, b, a, b])
        b['fixture']['id'] = 'a'
        with self.assertRaises(ValueError):
            batch_identities([a, b])

    def test_batch_cpu_consistency(self):
        with self.assertRaises(ValueError):
            batch_identities([{'fixture': {'id': str(i)}, 'system': {'cpu_name': str(i)}}
                              for i in range(2)])

    def test_empty_batch_rejected(self):
        with self.assertRaises(ValueError):
            batch_identities([])

    def test_invalid_json_number_rejected(self):
        with self.assertRaises(ValueError):
            single_identity([float('nan')] * 3, 'fixture')


if __name__ == '__main__':
    unittest.main()
