import { useState } from 'react';
import { useServices } from '@/services';
import { useAppStore } from '@/state/appStore';
import { useUiStore } from '@/state/uiStore';
import { log } from '@/state/logStore';
import { Dialog } from '../layout/Dialog';

export function NewProjectDialog({ onCreated }: { onCreated(path: string): void }) {
  const { session } = useServices();
  const open = useUiStore((s) => s.dialog === 'new-project');
  const openDialog = useUiStore((s) => s.openDialog);
  const notify = useAppStore((s) => s.notify);
  const [dir, setDir] = useState(`${session.workspaceRoot()}/tensorfleet`);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^[A-Za-z0-9_\-.]+$/.test(name) && dir.startsWith(session.workspaceRoot());
  const create = async () => {
    setBusy(true);
    try {
      const path = await session.createProject(dir, name);
      log(`Created project ${path}`);
      openDialog(null);
      onCreated(path);
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && openDialog(null)}
      title="New Project"
      size="narrow"
      description="Creates <name>/<name>.kicad_pro with an empty board and schematic (bridge: POST /files, then NewProject — gap G5)."
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid || busy} onClick={create}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>Folder</label>
        <input className="input mono" value={dir} onChange={(e) => setDir(e.target.value)} />
        <div className="help">Must be inside the workspace root {session.workspaceRoot()}</div>
        <label>Project name</label>
        <input className="input" value={name} placeholder="my-board" onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && valid && create()} />
        <div className="help">Letters, digits, dash, underscore and dot.</div>
      </div>
    </Dialog>
  );
}
