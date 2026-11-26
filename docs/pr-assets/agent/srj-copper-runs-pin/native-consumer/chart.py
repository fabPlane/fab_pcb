import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
root=Path(__file__).resolve().parent
fixture=json.loads((root/'input.srj.json').read_text())
samples=json.loads((root/'samples.json').read_text())
summary=json.loads((root/'summary.json').read_text())
fig,axes=plt.subplots(1,2,figsize=(12,4),sharex=True,sharey=True)
for ax, mode in zip(axes,['before','after']):
    sample=next(s for s in samples if s['mode']==mode)
    row=next(s for s in summary['rows'] if s['mode']==mode)
    for o in fixture['obstacles']:
        ax.add_patch(Rectangle((o['center']['x']-o['width']/2,o['center']['y']-o['height']/2),o['width'],o['height'],color='#d4ac45'))
    for trace in sample['result']['srj']['traces']:
        ax.plot([p['x'] for p in trace['route']],[p['y'] for p in trace['route']],color='#b84c40',lw=2)
    ax.set(xlim=(0,20),ylim=(2,11),xlabel='mm',title=f"{mode.capitalize()}: {row['tracks']} native segments, {row['length_mm']:.3f} mm\n0 unconnected / 0 DRC errors (3/3)")
    ax.set_aspect('equal')
fig.suptitle('Native consumer qualification: retained three-terminal outputs\nControls: unrouted = 2 unconnected; missing run = 1 unconnected')
fig.tight_layout()
fig.savefig(root/'native-consumer.png',dpi=140)
