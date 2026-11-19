# SPDX-License-Identifier: MIT
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('generate', ROOT / 'generate.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class NativeControl(unittest.TestCase):
    def test_fresh_drc_and_deterministic_terminal_identity(self):
        with tempfile.TemporaryDirectory(prefix='three-terminal-') as tmp:
            summaries = [module.generate(Path(tmp)/str(i)) for i in range(2)]
            self.assertEqual(summaries[0]['terminal_signature'], summaries[1]['terminal_signature'])
            for summary in summaries:
                rows = summary['results']
                self.assertEqual([r['native_opens'] for r in rows], [2,1,0])
                self.assertEqual([r['native_errors'] for r in rows], [0,0,0])
                self.assertEqual([r['native_warnings'] for r in rows], [0,0,0])
                self.assertEqual([r['candidate_completion'] for r in rows], [0,.5,1])
            for name in ('unrouted','partial','complete'):
                board = name+'.kicad_pcb'
                self.assertEqual((Path(tmp)/'0'/board).read_bytes(), (Path(tmp)/'1'/board).read_bytes())
                self.assertEqual((ROOT/board).read_bytes(), (Path(tmp)/'0'/board).read_bytes())

if __name__ == '__main__':
    unittest.main()
