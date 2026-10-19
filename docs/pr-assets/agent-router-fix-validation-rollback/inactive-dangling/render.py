from pathlib import Path
p = Path(__file__).resolve().parent
rows = [("Inactive marker: copper preserved", 0, 9, 9), ("Error/warning: cleanup retained", 6, 6, 6), ("Prior validation controls", 99, 99, 99)]
parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="550" viewBox="0 0 1200 550"><rect width="1200" height="550" fill="#111827"/><g font-family="sans-serif" fill="#f9fafb"><text x="45" y="55" font-size="29">Dangling cleanup respects effective marker severity</text><text x="45" y="90" font-size="18">Stateful adapter diagnostic · same machine · three repeats per version</text>']
for i, (label, before, after, total) in enumerate(rows):
 y = 145 + i * 115
 parts.append(f'<text x="45" y="{y}" font-size="21">{label}</text>')
 for j, (version, value, color) in enumerate([("Before", before, "#f59e0b"), ("After", after, "#34d399")]):
  yy = y + 13 + j*31
  parts.append(f'<text x="55" y="{yy+20}" font-size="17">{version}</text><rect x="150" y="{yy}" width="750" height="23" fill="#374151"/><rect x="150" y="{yy}" width="{750*value/total}" height="23" fill="{color}"/><text x="920" y="{yy+19}" font-size="18">{value}/{total}</text>')
parts.append('<text x="45" y="525" font-size="17">Stand-in commit/undo fixture; live native thermal safety remains unverified.</text></g></svg>')
(p/'severity.svg').write_text(''.join(parts))
