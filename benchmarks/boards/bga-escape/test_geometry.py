# SPDX-License-Identifier: MIT
"""The fixed fixture schema must reject routing and unchecked constraints."""
import copy
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from validate import ROOT, geometry


class GeometryTest(unittest.TestCase):
    def test_unchecked_top_level_fields(self):
        specs = json.loads((ROOT / 'manifest.json').read_text())['boards']
        for spec in specs:
            tier = spec['tier']
            with tempfile.TemporaryDirectory(prefix='bga-schema-') as temp:
                source = Path(temp)
                shutil.copytree(ROOT / tier, source / tier)
                target = source / tier / 'unrouted.srj.json'
                original = json.loads(target.read_text())
                self.assertEqual(geometry(source, spec)[:2], (100, 200))
                variants = {
                    'traces': [{'type': 'pcb_trace', 'route': []}],
                    'vias': [{'x': 25, 'y': 25}],
                    'keepouts': [{'x': 25, 'y': 25}],
                    'minViaDiameter': .8,
                    'minTraceClearance': .5,
                }
                for field, value in variants.items():
                    with self.subTest(tier=tier, field=field):
                        changed = copy.deepcopy(original)
                        changed[field] = value
                        target.write_text(json.dumps(changed))
                        with self.assertRaisesRegex(ValueError, 'unexpected SRJ fields'):
                            geometry(source, spec)
                target.write_text(json.dumps(original))
                self.assertEqual(geometry(source, spec)[:2], (100, 200))


if __name__ == '__main__':
    unittest.main()
