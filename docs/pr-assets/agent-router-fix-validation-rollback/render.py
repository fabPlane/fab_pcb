#!/usr/bin/env python3
"""Plot measured fault-injection states; these are item counts, not native DRC scores."""
import json
from pathlib import Path
import subprocess
p = Path(__file__).resolve().parent
result = json.loads((p / 'audit.json').read_text())
parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="620" viewBox="0 0 1200 620">',
         '<rect width="1200" height="620" fill="#f5f7fa"/>',
         '<g font-family="sans-serif" fill="#172838">',
         '<text x="55" y="55" font-size="28" font-weight="bold">Native validation unavailable: tentative copper after failure</text>',
         '<text x="55" y="88" font-size="18">Stateful adapter fault injection · three identical repeats per scenario and version</text>']
for index, (scenario, label) in enumerate([('first-check-failure', 'First validation fails'), ('cleanup-retry-failure', 'Validation fails after stub cleanup')]):
    x = 55 + 570 * index
    parts.append(f'<text x="{x}" y="145" font-size="21" font-weight="bold">{label}</text>')
    for version_index, version in enumerate(('before', 'after')):
        rows = [r for r in result[version]['rows'] if r['scenario'] == scenario]
        assert len(rows) == 3
        assert len({(r['addedCopper'], r['missingOriginal']) for r in rows}) == 1
        row = rows[0]
        for metric_index, (field, text, color) in enumerate([('addedCopper', 'Unvalidated route items', '#c3473f'), ('missingOriginal', 'Missing original items', '#b17920')]):
            y = 205 + version_index * 145 + metric_index * 50
            count = row[field]
            parts.append(f'<text x="{x}" y="{y}" font-size="18">{version.title()}: {text}</text>')
            parts.append(f'<rect x="{x}" y="{y+10}" width="{350*count}" height="19" rx="3" fill="{color}"/>')
            parts.append(f'<text x="{x+370}" y="{y+26}" font-size="20" fill="{color if count else "#28744e"}">{count}</text>')
parts += ['<text x="55" y="535" font-size="19" fill="#28744e">After: original copper restored in 6/6 failure scenarios; no final save or success summary.</text>',
          '<text x="55" y="570" font-size="17">Valid-route control: retained in 3/3 repeats on both versions. Thermal starvation remains unresolved.</text>', '</g></svg>']
(p / 'rollback.svg').write_text('\n'.join(parts))
subprocess.run(['rsvg-convert', '-w', '1600', str(p/'rollback.svg'), '-o', str(p/'rollback.png')], check=True)
