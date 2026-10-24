#!/usr/bin/env python3
import json, subprocess
from pathlib import Path
root = Path(__file__).resolve().parent
report = json.loads((root / 'audit.json').read_text())
parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="400" viewBox="0 0 1000 400"><rect width="1000" height="400" fill="white"/><g font-family="sans-serif" fill="#172b4d"><text x="40" y="48" font-size="26">Tentative undo ownership regressions</text><text x="40" y="82" font-size="17">Same four adapter tests, three repeats per version</text>']
for i, version in enumerate(('before', 'after')):
    rows = report['versions'][version]['runs']
    assert len({r['passed'] for r in rows}) == 1
    passed = rows[0]['passed']
    y = 130 + 95*i
    parts.append(f'<text x="40" y="{y+28}" font-size="20">{version}</text><rect x="160" y="{y}" width="600" height="44" fill="#e7ebef"/><rect x="160" y="{y}" width="{150*passed}" height="44" fill="#21885c"/><text x="790" y="{y+28}" font-size="20">{passed}/4 pass</text>')
parts.append('<text x="40" y="344" font-size="17">Stateful API stand-in; live native undo and thermal safety remain unverified.</text></g></svg>')
(root / 'ownership.svg').write_text(''.join(parts))
subprocess.run(['rsvg-convert', '-w', '1600', str(root/'ownership.svg'), '-o', str(root/'ownership.png')], check=True)
