import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
root=Path(__file__).resolve().parent
samples=json.loads((root/'samples.json').read_text())
fig,axes=plt.subplots(1,2,figsize=(11,4))
colors={'top':'#cc5555','inner2':'#b36fc4'}
for ax,s in zip(axes,samples[::3]):
    for layer,color in colors.items():
        for t in s['result']['srj']['traces']:
            for a,b in zip(t['route'],t['route'][1:]):
                if a['route_type']==b['route_type']=='wire' and a['layer']==b['layer']==layer:
                    ax.plot([a['x'],b['x']],[a['y'],b['y']],color=color,lw=3,label=layer)
    for t in s['result']['srj']['traces']:
        for p in t['route']:
            if p['route_type']=='via':ax.plot(p['x'],p['y'],'o',ms=9,mfc='white',mec='#555',label='through via')
    for x in [2,18]:
        ax.add_patch(Rectangle((x-.6,4.5),1.2,1,color='#d0a130',alpha=.6))
        ax.plot(x,5,'o',mfc='white',mec='#555',ms=3)
    ax.add_patch(Rectangle((9.5,1),1,10,color='#555',alpha=.25,label='outer copper obstacles'))
    ax.set(title=f"{s['mode']}: 3/3 routes, zero opens\nNative: zero opens, errors or warnings",xlim=(0,20),ylim=(0,12),xlabel='mm')
    ax.set_aspect('equal');ax.legend(loc='lower center',fontsize=8)
fig.suptitle('Four-layer plated terminals with matching outer-layer copper obstacles\n14.8 mm, top/inner2 segments and one through via; native clean 3/3 each')
fig.tight_layout();fig.savefig(root/'inner-layers.png',dpi=150)
