// "Update PCB from schematic" (`SyncSchematicToBoard`): KiCad exports the netlist in-process and
// runs the netlist updater over the open board, so there is no file to write. The dialog runs a
// dry run first — the report is the whole point of the dialog — and only then offers to apply it.

import { useState } from 'react';
import { useServices } from '@/services';
import type { SyncOptions, SyncReport } from '@/services/types';
import { useAppStore } from '@/state/appStore';
import { log } from '@/state/logStore';
import { useUiStore } from '@/state/uiStore';
import { Dialog } from '../layout/Dialog';

export function UpdatePcbDialog() {
  const dialog = useUiStore((s) => s.dialog);
  const openDialog = useUiStore((s) => s.openDialog);
  const { schematic } = useServices();
  const [opts, setOpts] = useState<Required<Pick<SyncOptions, 'matchMode' | 'deleteExtraFootprints' | 'updateFootprints' | 'updateFields' | 'removeExtraFields'>>>({
    matchMode: 'uuid',
    deleteExtraFootprints: false,
    updateFootprints: true,
    updateFields: true,
    removeExtraFields: false,
  });
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = dialog === 'update-pcb';

  const run = async (dryRun: boolean) => {
    if (!schematic) return;
    setBusy(true);
    setError(null);
    try {
      const r = await schematic.syncToBoard({ ...opts, dryRun });
      setReport(r);
      log(`SyncSchematicToBoard${dryRun ? ' (dry run)' : ''}: ${r.newFootprintCount} new, ${r.errorCount} errors, ${r.warningCount} warnings`);
      if (!dryRun) useAppStore.getState().notify(`PCB updated: ${r.newFootprintCount} footprint(s) added`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setReport(null);
    } finally {
      setBusy(false);
    }
  };

  const flag = (key: keyof typeof opts, label: string, help?: string) => (
    <>
      <label htmlFor={`sync-${key}`}>{label}</label>
      <span>
        <input id={`sync-${key}`} type="checkbox" className="checkbox" checked={opts[key] as boolean} onChange={(e) => setOpts({ ...opts, [key]: e.target.checked })} />
        {help && <span className="help"> {help}</span>}
      </span>
    </>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && openDialog(null)}
      title="Update PCB from schematic"
      description="Runs KiCad's netlist updater over the open board. Preview first — the report lists every change before anything is applied."
      size="wide"
      footer={
        <>
          <button className="btn" disabled={busy || !schematic} onClick={() => void run(true)} data-testid="sync-preview">
            {busy ? 'Working…' : 'Preview changes'}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Close
          </button>
          <button className="btn primary" disabled={busy || !schematic} onClick={() => void run(false)} data-testid="sync-apply">
            Update PCB
          </button>
        </>
      }
    >
      {!schematic && <div className="empty-state">Updating the PCB needs the KiCad services (the mock has no netlist updater).</div>}
      {schematic && (
        <>
          <div className="form-grid">
            <label htmlFor="sync-match">Match footprints by</label>
            <select id="sync-match" className="select" value={opts.matchMode} onChange={(e) => setOpts({ ...opts, matchMode: e.target.value as 'uuid' | 'reference' })}>
              <option value="uuid">Unique id (recommended)</option>
              <option value="reference">Reference designator</option>
            </select>
            {flag('updateFootprints', 'Replace changed footprints', 'when the symbol names a different library footprint')}
            {flag('updateFields', 'Copy symbol fields to footprints')}
            {flag('removeExtraFields', 'Remove footprint fields the symbol lacks')}
            {flag('deleteExtraFootprints', 'Delete footprints with no symbol')}
          </div>

          {error && (
            <div className="empty-state" style={{ color: 'var(--danger)' }} role="alert">
              {error}
            </div>
          )}
          {report && (
            <div className="report" data-testid="sync-report">
              <p>
                {report.dryRun ? 'Preview: ' : 'Applied: '}
                <strong>{report.newFootprintCount}</strong> new footprint(s) · <strong className={report.errorCount ? 'sev-error' : ''}>{report.errorCount}</strong> error(s) ·{' '}
                <strong>{report.warningCount}</strong> warning(s)
              </p>
              <pre className="log-lines" style={{ maxHeight: 260 }}>
                {report.report || '(no changes)'}
              </pre>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
