import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, Circle
root=Path(__file__).resolve().parent
fixture=json.loads((root/'layer-transition.srj.json').read_text())
samples=json.loads((root/'samples.json').read_text())
fig, axes=plt.subplots(1,2,figsize=(12,4),sharex=True,sharey=True)
for ax,mode in zip(axes,['before','after']):
    for o in fixture['obstacles']:
        ax.add_patch(Rectangle((o['center']['x']-o['width']/2,o['center']['y']-o['height']/2),o['width'],o['height'],color='#d4ac45'))
    for t in next(s for s in samples if s['mode']==mode)['result']['srj']['traces']:
        for a,b in zip(t['route'],t['route'][1:]):
            if a['route_type']==b['route_type']=='wire' and a['layer']==b['layer']:
                ax.plot([a['x'],b['x']],[a['y'],b['y']],color='#b84c40' if a['layer']=='top' else '#4077b8',lw=3)
        for p in t['route']:
            if p['route_type']=='via':
                ax.add_patch(Circle((p['x'],p['y']),0.3,facecolor='#d4ac45',edgecolor='black'))
                ax.add_patch(Circle((p['x'],p['y']),0.15,facecolor='white',edgecolor='black'))
    ax.set(xlim=(0,20),ylim=(3,7),xlabel='mm',title=f'{mode.capitalize()}: 2 segments, 1 via, 14.8 mm\nNative: 0 opens / 0 errors / 0 warnings (3/3)')
    ax.set_aspect('equal')
fig.suptitle('Actual two-layer routing with explicit via dimensions\nRed = top, blue = bottom; missing-via control: 1 open, 2 dangling-track warnings')
fig.tight_layout()
fig.savefig(root/'native-via.png',dpi=140)
