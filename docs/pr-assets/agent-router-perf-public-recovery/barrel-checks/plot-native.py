"""Render actual retained and added native copper in the measured closure region."""
from pathlib import Path
import json,sys,math
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Circle,Polygon,Rectangle
p,out=map(Path,sys.argv[1:]);d=json.loads(p.read_text());added={tuple(t)for t in d['added_segments']};pts=[(t[i]/1e6,t[i+1]/1e6)for t in added for i in [3,5]]
x0,x1=min(p[0]for p in pts)-.6,max(p[0]for p in pts)+.6;y0,y1=min(p[1]for p in pts)-.6,max(p[1]for p in pts)+.6
fig,axes=plt.subplots(1,2,figsize=(12,6.5),constrained_layout=True)
def copper(ax,t,color,z):
 _,_,w,x,y,xx,yy=t;w/=2e6;x/=1e6;y/=1e6;xx/=1e6;yy/=1e6;length=math.hypot(xx-x,yy-y)
 if length:
  nx,ny=-(yy-y)/length*w,(xx-x)/length*w
  ax.add_patch(Polygon([(x+nx,y+ny),(xx+nx,yy+ny),(xx-nx,yy-ny),(x-nx,y-ny)],color=color,lw=0,zorder=z))
 for pt in [(x,y),(xx,yy)]:ax.add_patch(Circle(pt,w,color=color,lw=0,zorder=z))
for i,(ax,b)in enumerate(zip(axes,d['boards'])):
 for pad in b['pads']:
  x,y=pad['x0']/1e6,pad['y0']/1e6;w,h=(pad['x1']-pad['x0'])/1e6,(pad['y1']-pad['y0'])/1e6
  if x<x1 and x+w>x0 and y<y1 and y+h>y0:ax.add_patch(Rectangle((x,y),w,h,facecolor='#b4cfe8'if pad['net']==d['net']else '#d9e0e5',edgecolor='#185c9b'if pad['net']==d['net']else 'none',lw=.7,zorder=0))
 for t in b['segments']:copper(ax,t,'#ad7800'if tuple(t)in added else '#185c9b'if t[0]==d['net']else '#9aa4ae',3 if tuple(t)in added else 1)
 for v in b['vias']:
  ax.add_patch(Circle((v['x']/1e6,v['y']/1e6),v['diameter']/2e6,color='#185c9b'if v['net']==d['net']else '#9aa4ae',lw=0,zorder=2));ax.add_patch(Circle((v['x']/1e6,v['y']/1e6),v['drill']/2e6,color='white',lw=0,zorder=3))
 ax.set(xlim=(x0,x1),ylim=(y1,y0),xlabel='mm',ylabel='mm',title=f"{'Before'if i==0 else'After'}: {d['opens'][i]} native opens, {d['new_errors'][i]} new errors")
 ax.set_aspect('equal');ax.grid(alpha=.15)
fig.suptitle(f"Dense6 native connection on {d['layer_name']} · {d['net_name']}\nGold: new copper; blue: target net; grey: other nets; pad bounds shown")
fig.savefig(out,dpi=160)
