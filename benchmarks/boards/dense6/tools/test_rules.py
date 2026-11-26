# SPDX-License-Identifier: MIT
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class RulesTest(unittest.TestCase):
    def test_unpinned_custom_rules_cannot_enter_the_fixture(self):
        spec = importlib.util.spec_from_file_location('dense_validator', ROOT / 'validate.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        manifest = json.loads((ROOT / 'manifest.json').read_text())
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)
            for name in manifest['sha256']:
                shutil.copyfile(ROOT / name, source / name)
            (source / 'dense6-bga324.kicad_dru').write_text('(version 1)\n')
            with self.assertRaisesRegex(ValueError, 'custom rule sidecar'):
                module.validate(source, manifest['sha256'])


if __name__ == '__main__':
    unittest.main()
