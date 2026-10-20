# SPDX-License-Identifier: MIT
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('bga1296', ROOT/'generate.py')
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)

class NativeCandidate(unittest.TestCase):
    def test_committed_artifact_digests(self):
        summary = json.loads((ROOT/"summary.json").read_text())
        expected = {"bga1296.kicad_pcb", "bga1296.kicad_pro", "bga1296.dsn"}
        self.assertEqual(set(summary["sha256"]), expected)
        for name in sorted(expected):
            with self.subTest(artifact=name):
                self.assertEqual(hashlib.sha256((ROOT/name).read_bytes()).hexdigest(), summary["sha256"][name])

    def test_repeated_native_admission_and_exact_artifacts(self):
        with tempfile.TemporaryDirectory() as parent:
            for i in range(3):
                out = Path(parent)/str(i)
                summary = generator.generate(out)
                self.assertEqual(summary['parameters'], json.loads((ROOT/'summary.json').read_text())['parameters'])
                self.assertEqual((summary['native_errors'],summary['native_warnings'],summary['native_connectivity_opens']),(0,0,1296))
                self.assertEqual(len(summary['copper_stack']),8)
                self.assertEqual(summary['reported_opens'],499)
                self.assertTrue(summary['report_limit_reached'])
                for name in ('bga1296.kicad_pcb','bga1296.kicad_pro','bga1296.dsn'):
                    self.assertEqual((ROOT/name).read_bytes(),(out/name).read_bytes())

if __name__ == '__main__':
    unittest.main()
