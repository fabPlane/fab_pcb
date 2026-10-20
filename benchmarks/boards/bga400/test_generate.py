# SPDX-License-Identifier: MIT
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('bga400', ROOT/'generate.py')
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)

class NativeCandidate(unittest.TestCase):
    def test_repeated_native_admission_and_exact_artifacts(self):
        with tempfile.TemporaryDirectory() as parent:
            for i in range(3):
                out = Path(parent)/str(i)
                summary = generator.generate(out)
                self.assertEqual(summary['parameters'], json.loads((ROOT/'summary.json').read_text())['parameters'])
                self.assertEqual((summary['native_errors'],summary['native_warnings'],summary['native_opens']),(0,0,400))
                self.assertEqual(len(summary['copper_stack']),8)
                for name in ('bga400.kicad_pcb','bga400.kicad_pro','bga400.dsn'):
                    self.assertEqual((ROOT/name).read_bytes(),(out/name).read_bytes())

if __name__ == '__main__':
    unittest.main()
