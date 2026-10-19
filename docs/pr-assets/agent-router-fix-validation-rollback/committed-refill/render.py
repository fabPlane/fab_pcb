from pathlib import Path
p = Path(__file__).resolve().parent
rows = [('Failed final validation: explicit rollback refusal', 6, 6), ('Failed final validation: original state restored', 0, 6), ('Clean final validation: route saved', 3, 3)]
s = ['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="520"><rect width="1200" height="520" fill="#111827"/><g font-family="sans-serif" fill="#f9fafb"><text x="40" y="55" font-size="30">Successful refill can prevent route rollback</text><text x="40" y="90" font-size="19">Stateful diagnostic · three repeats · identical before/after production</text>']
for i,(label,value,total) in enumerate(rows):
 y=145+i*105
 s.append(f'<text x="40" y="{y}" font-size="22">{label}</text><rect x="40" y="{y+20}" width="900" height="30" fill="#374151"/><rect x="40" y="{y+20}" width="{900*value/total}" height="30" fill="#60a5fa"/><text x="970" y="{y+44}" font-size="23">{value}/{total}</text>')
s.append('<text x="40" y="490" font-size="18">Coverage added; restoration remains unresolved. No live native safety gain.</text></g></svg>')
(p/'refill.svg').write_text(''.join(s))
