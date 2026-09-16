// Annotate the schematic (`Annotate` / `ClearAnnotation`): KiCad's dialog, minus the options the
// headless API does not expose. The report KiCad returns is shown in place rather than as a toast,
// because "0 annotated, 3 errors" is the interesting answer.

import { useState } from 'react';
import { useServices } from '@/services';
import type { AnnotateReport, AnnotateOptions } from '@/services/types';
import { useAppStore } from '@/state/appStore';
import { useEditorDoc } from '@/state/editorStore';
import { storeKeyFor } from '@/state/active';
import { log } from '@/state/logStore';
import { useUiStore } from '@/state/uiStore';
import { Dialog } from '../layout/Dialog';

const SCOPES: { value: AnnotateOptions['scope']; label: string }[] = [
  { value: 'all', label: 'Whole schematic' },
  { value: 'sheet', label: 'Current sheet' },
  { value: 'selection', label: 'Selection' },
];
const ORDERS: { value: AnnotateOptions['sortOrder']; label: string }[] = [
  { value: 'x', label: 'Sort by X position' },
  { value: 'y', label: 'Sort by Y position' },
  { value: 'unsorted', label: 'Keep existing order' },
];
const NUMBERINGS: { value: AnnotateOptions['numbering']; label: string }[] = [
  { value: 'incremental', label: 'Use first free number' },
  { value: 'sheetX100', label: 'Start at sheet number × 100' },
  { value: 'sheetX1000', label: 'Start at sheet number × 1000' },
];

export function AnnotateDialog() {
  const dialog = useUiStore((s) => s.dialog);
  const openDialog = useUiStore((s) => s.openDialog);
  const { schematic } = useServices();
  const activeSheet = useAppStore((s) => s.activeSheet);
  const [scope, setScope] = useState<AnnotateOptions['scope']>('all');
  const [sortOrder, setSortOrder] = useState<AnnotateOptions['sortOrder']>('x');
  const [numbering, setNumbering] = useState<AnnotateOptions['numbering']>('incremental');
  const [startNumber, setStartNumber] = useState(1);
  const [resetExisting, setResetExisting] = useState(false);
  const [recursive, setRecursive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<AnnotateReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = dialog === 'annotate';
  const selection = useEditorDoc(storeKeyFor('schematic', activeSheet)).selection;

  const options = (): AnnotateOptions => ({
    scope,
    sortOrder,
    numbering,
    startNumber,
    resetExisting,
    recursive,
    items: scope === 'selection' ? selection : undefined,
    sheetPath: scope === 'sheet' ? activeSheet : undefined,
  });

  const run = async (clear: boolean) => {
    if (!schematic) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const r = clear ? await schematic.clearAnnotation({ scope, items: options().items, recursive }) : await schematic.annotate(options());
      setReport(r);
      log(`${clear ? 'ClearAnnotation' : 'Annotate'}: ${r.annotatedCount}/${r.symbolCount} symbols, ${r.errorCount} problem(s)`);
      useAppStore.getState().notify(`${clear ? 'Cleared' : 'Annotated'} ${r.annotatedCount} of ${r.symbolCount} symbols`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && openDialog(null)}
      title="Annotate schematic"
      description="Assigns references to the symbols KiCad's annotator considers unannotated (or every symbol, with “reset existing”)."
      footer={
        <>
          <button className="btn" disabled={busy || !schematic} onClick={() => void run(true)} data-testid="annotate-clear">
            Clear annotation
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Close
          </button>
          <button className="btn primary" disabled={busy || !schematic} onClick={() => void run(false)} data-testid="annotate-run">
            {busy ? 'Annotating…' : 'Annotate'}
          </button>
        </>
      }
    >
      {!schematic && <div className="empty-state">Annotation needs the KiCad services (the mock has no schematic operations).</div>}
      {schematic && (
        <>
          <div className="form-grid">
            <label htmlFor="annotate-scope">Scope</label>
            <select id="annotate-scope" data-testid="annotate-scope" className="select" value={scope} onChange={(e) => setScope(e.target.value as AnnotateOptions['scope'])}>
              {SCOPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <span className="help">
              {scope === 'selection' ? `${selection.length} item(s) selected on ${activeSheet}` : scope === 'sheet' ? `Sheet ${activeSheet}` : 'Every sheet of the hierarchy'}
            </span>

            <label htmlFor="annotate-order">Order</label>
            <select id="annotate-order" className="select" value={sortOrder} onChange={(e) => setSortOrder(e.target.value as AnnotateOptions['sortOrder'])}>
              {ORDERS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>

            <label htmlFor="annotate-numbering">Numbering</label>
            <select id="annotate-numbering" className="select" value={numbering} onChange={(e) => setNumbering(e.target.value as AnnotateOptions['numbering'])}>
              {NUMBERINGS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>

            <label htmlFor="annotate-start">Start number</label>
            <input id="annotate-start" data-testid="annotate-start" className="input" type="number" min={0} value={startNumber} onChange={(e) => setStartNumber(Number(e.target.value))} />

            <label htmlFor="annotate-reset">Reset existing</label>
            <span>
              <input id="annotate-reset" data-testid="annotate-reset" type="checkbox" className="checkbox" checked={resetExisting} onChange={(e) => setResetExisting(e.target.checked)} />{' '}
              <span className="help">Re-number every symbol instead of only the unannotated ones</span>
            </span>

            <label htmlFor="annotate-recursive">Include sub-sheets</label>
            <span>
              <input id="annotate-recursive" type="checkbox" className="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} disabled={scope === 'all'} />
            </span>
          </div>

          {error && (
            <div className="empty-state" style={{ color: 'var(--danger)' }} role="alert">
              {error}
            </div>
          )}
          {report && (
            <div className="report" data-testid="annotate-report">
              <p>
                <strong>{report.annotatedCount}</strong> of <strong>{report.symbolCount}</strong> symbols annotated · <strong>{report.errorCount}</strong> problem(s)
              </p>
              {report.messages.length > 0 && <pre className="log-lines">{report.messages.join('\n')}</pre>}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
