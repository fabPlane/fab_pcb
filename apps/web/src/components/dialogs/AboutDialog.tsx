import { useUiStore } from '@/state/uiStore';
import { useAppStore } from '@/state/appStore';
import { Dialog } from '../layout/Dialog';

export function AboutDialog() {
  const open = useUiStore((s) => s.dialog === 'about');
  const openDialog = useUiStore((s) => s.openDialog);
  const session = useAppStore((s) => s.session);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && openDialog(null)} title="About kicad-web" size="narrow">
      <p style={{ marginTop: 0 }}>
        A browser front end for KiCad 10.99 running headless as <span className="mono">kicad-cli api-server</span>. Everything on screen comes from the IPC API; there is no desktop KiCad window behind it.
      </p>
      <div className="form-grid">
        <label>App</label>
        <span className="mono">@kicad-web/app 0.0.1</span>
        <label>Services</label>
        <span className="mono">mock (in-memory kitchen sink)</span>
        <label>Renderer</label>
        <span className="mono">MockCanvasHost (Canvas2D)</span>
        <label>KiCad</label>
        <span className="mono">{session?.kicadVersion ?? 'not connected'}</span>
        <label>Session</label>
        <span className="mono">{session?.id ?? '—'}</span>
      </div>
    </Dialog>
  );
}
