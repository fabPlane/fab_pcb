from pathlib import Path
import re
root=Path(__file__).parent
counts={}
for version in ['before','after']:
    logs=[(root/f'{version}-{i}.log').read_text() for i in range(1,4)]
    counts[version]=sum(len(re.findall(r'\(pass\) rejects new native errors with zone refill disabled',log)) for log in logs)
assert counts == {'before':0,'after':9}, counts
import subprocess
svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="480"><rect width="1000" height="480" fill="white"/><g font-family="sans-serif" fill="#172b3a"><text x="50" y="45" font-size="25">Native error rejection with zone refill disabled</text><text x="50" y="80" font-size="19">3 scenarios × 3 repeats; stateful adapter fixture</text><path d="M120 120V390H900" stroke="#172b3a" fill="none"/>'
for x,(label,value),color in zip([270,650],counts.items(),['#b74646','#287a59']):
    height=value*27
    svg += f'<rect x="{x}" y="{390-height}" width="150" height="{max(height,2)}" fill="{color}"/><text x="{x+75}" y="{375-height}" text-anchor="middle" font-size="24">{value}/9</text><text x="{x+75}" y="425" text-anchor="middle" font-size="22">{label.title()}</text>'
svg += '<text x="50" y="465" font-size="17">Raw repeated test logs determine bar heights; native benchmark not run.</text></g></svg>'
(root/'unfilled-errors.svg').write_text(svg)
subprocess.run(['rsvg-convert','-w','1600',str(root/'unfilled-errors.svg'),'-o',str(root/'unfilled-errors.png')],check=True)
