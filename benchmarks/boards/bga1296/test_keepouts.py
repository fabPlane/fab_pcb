# SPDX-License-Identifier: MIT
import importlib.util
import json
import re
import sys
import unittest
from pathlib import Path
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('candidate', ROOT/'generate.py')
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)
LAYERS = ['F.Cu', 'B.Cu'] + [f'In{i}.Cu' for i in range(1, 7)]

def controls(text):
    first = re.search(r'\(keepout "".*?\)\)', text, re.S).group()
    second = re.findall(r'\(keepout "".*?\)\)', text, re.S)[8]
    return {
        'valid': text,
        'shifted': text.replace('29000 -31000', '29001 -31000', 1),
        'resized': text.replace('32000 -59000', '33000 -59000', 1),
        'duplicate': text.replace(second, first, 1),
        'wrong-layer': text.replace('(polygon F.Cu 0 ', '(polygon In9.Cu 0 ', 1),
        'aperture': text.replace('(polygon F.Cu 0 ', '(polygon F.Cu 1 ', 1),
        'wrong-unit': text.replace('(unit um)', '(unit mm)'),
        'nonfinite': text.replace('29000 -31000', 'NaN -31000', 1),
        'open-polygon': text.replace(first, first.replace('29000 -31000))', '29000 -31001))'), 1),
        'extra-vertex': text.replace(first, first.replace('))', ' 29000 -31000))'), 1),
    }

def previous(text):
    if text.count('(keepout ') != 16 or any(text.count(f'(polygon {layer} 0 ') != 2 for layer in LAYERS):
        raise RuntimeError('previous count admission failed')

class GeometryAdmission(unittest.TestCase):
    def test_mutations(self):
        text = (ROOT/'bga1296.dsn').read_text()
        for name, mutated in controls(text).items():
            with self.subTest(control=name):
                if name == 'valid':
                    generator.validate_keepouts(mutated, LAYERS)
                else:
                    self.assertNotEqual(text, mutated)
                    with self.assertRaises(RuntimeError):
                        generator.validate_keepouts(mutated, LAYERS)

if __name__ == '__main__':
    if len(sys.argv) == 2 and sys.argv[1] == '--measure':
        rows = []
        for repeat in range(3):
            # Fresh native generation and export each repeat, no cached reports.
            import tempfile
            with tempfile.TemporaryDirectory() as parent:
                out = Path(parent)/'fresh'
                summary = generator.generate(out)
                for case, text in controls((out/'bga1296.dsn').read_text()).items():
                    for label, implementation in [('before', previous), ('after', lambda x: generator.validate_keepouts(x, LAYERS))]:
                        try:
                            implementation(text)
                            accepted = True
                        except RuntimeError:
                            accepted = False
                        rows.append(dict(repeat=repeat, case=case, implementation=label, accepted=accepted))
        print(json.dumps(dict(repeats=3, rows=rows, artifact_sha256=summary['sha256']), indent=2))
    else:
        unittest.main()
