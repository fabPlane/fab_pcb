from pathlib import Path
import subprocess
import pcbnew as p
r=Path(__file__).resolve().parents[4];s=Path(__file__).resolve().parent;a=s
b=p.LoadBoard(str(r/'benchmarks/boards/bga1296/bga1296.kicad_pcb'))
svg=['<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="980"><rect width="1600" height="980" fill="#f4f7fa"/><g font-family="sans-serif" fill="#17263b"><text x="800" y="45" text-anchor="middle" font-size="28">Eight-layer BGA1296 routing keepout candidate · seed 6596</text>']
for left,top,scale,xmin,ymin,span in [(65,145,660/90,0,0,90),(850,145,660/19,35.5,35.5,19)]:
 svg.append(f'<rect x="{left}" y="{top}" width="660" height="660" fill="#153c37"/>')
 if xmin==0:
  for x in (29,58):svg.append(f'<rect x="{left+x*scale}" y="{top+31*scale}" width="{3*scale}" height="{28*scale}" fill="#e96d64"/>')
 for f in b.GetFootprints():
  for pad in f.Pads():
   pos=pad.GetPosition();x,y=p.ToMM(pos.x),p.ToMM(pos.y)
   if xmin<=x<=xmin+span and ymin<=y<=ymin+span:svg.append(f'<circle cx="{left+(x-xmin)*scale:.4f}" cy="{top+(y-ymin)*scale:.4f}" r="{p.ToMM(pad.GetSize().x)*scale/2:.4f}" fill="#e5bd6a"/>')
svg+=['<text x="395" y="115" text-anchor="middle" font-size="21">90 × 90 mm · red: all-layer track/via keepouts</text>','<text x="1180" y="115" text-anchor="middle" font-size="21">36 × 36 BGA · 0.5 mm pitch · 0.2 mm pads</text>','<text x="800" y="855" text-anchor="middle" font-size="22">1,296 nets · 2,592 pads · 8 signal layers · unrouted input</text>','<text x="800" y="892" text-anchor="middle" font-size="21">Native geometry: 0 violations · connectivity API: 1,296 opens</text>','<text x="800" y="929" text-anchor="middle" font-size="20">DRC report: 499 opens (capped) · no routed feasibility or exact quality claim</text></g></svg>']
(s/'board.svg').write_text('\n'.join(svg));subprocess.run(['rsvg-convert',str(s/'board.svg'),'-o',str(a/'board.png')],check=True)
