# SPDX-License-Identifier: MIT
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class ExportTest(unittest.TestCase):
    def test_failed_load_removes_stale_export(self):
        script = Path(__file__).resolve().parents[1] / 'export.py'
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / 'stale.dsn'
            target.write_text('stale')
            result = subprocess.run([sys.executable, str(script), str(root / 'missing.kicad_pcb'),
                                     str(target)], capture_output=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(target.exists())

    def test_source_cannot_be_used_as_the_export_destination(self):
        script = Path(__file__).resolve().parents[1] / 'export.py'
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'board.kicad_pcb'
            source.write_text('preserve source')
            result = subprocess.run([sys.executable, str(script), str(source), str(source)],
                                    capture_output=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(source.read_text(), 'preserve source')


if __name__ == '__main__':
    unittest.main()
