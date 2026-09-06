// Page settings + title block of the active document (board or schematic):
// GetPageSettings / GetTitleBlockInfo on open, SetPageSettings / SetTitleBlockInfo on OK.
// The headless schematic answers "this editor does not support page settings"; that (and
// any other refusal) is shown verbatim.

import { useEffect, useState } from 'react';
import { useServices } from '@/services';
import type { PageInfo } from '@/services/types';
import { useAppStore } from '@/state/appStore';
import { useUiStore } from '@/state/uiStore';
import { formatDistance, parseDistance } from '@/lib/units';
import { log } from '@/state/logStore';
import { Dialog } from '../layout/Dialog';

const PAGE_SIZES = ['PS_A5', 'PS_A4', 'PS_A3', 'PS_A2', 'PS_A1', 'PS_A0', 'PS_A', 'PS_B', 'PS_C', 'PS_D', 'PS_E', 'PS_USER'];

interface PageDocs {
  pageInfo?(kind: 'board' | 'schematic'): Promise<PageInfo>;
  setPageInfo?(kind: 'board' | 'schematic', info: PageInfo): Promise<void>;
}

export function PageSettingsDialog() {
  const { documents } = useServices();
  const open = useUiStore((s) => s.dialog === 'page-settings');
  const openDialog = useUiStore((s) => s.openDialog);
  const units = useUiStore((s) => s.units);
  const editor = useAppStore((s) => s.activeEditor);
  const kind: 'board' | 'schematic' = editor === 'schematic' ? 'schematic' : 'board';
  const [draft, setDraft] = useState<PageInfo | null>(null);
  const [before, setBefore] = useState<PageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const docs = documents as PageDocs;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDraft(null);
    if (!docs.pageInfo) {
      setError('Page settings are not available with the mock services.');
      return;
    }
    docs
      .pageInfo(kind)
      .then((p) => {
        setBefore(p);
        setDraft(structuredClone(p));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [open, kind, docs]);

  const field = (label: string, key: keyof PageInfo) =>
    draft && (
      <>
        <label>{label}</label>
        <input className="input" value={String(draft[key] ?? '')} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} data-page={key} />
      </>
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && openDialog(null)}
      title={`Page Settings — ${kind === 'board' ? 'board' : 'schematic'}`}
      description="Drawing sheet size and title block (GetPageSettings / GetTitleBlockInfo → SetPageSettings / SetTitleBlockInfo)."
      footer={
        <>
          {error && (
            <span className="muted" role="alert" style={{ color: 'var(--danger)' }}>
              {error}
            </span>
          )}
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!draft || busy || !docs.setPageInfo}
            onClick={async () => {
              if (!draft || !docs.setPageInfo) return;
              setBusy(true);
              try {
                await docs.setPageInfo(kind, draft);
                useAppStore.getState().notify('Page settings saved');
                openDialog(null);
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                log(`page settings: ${msg}`, 'error');
                setError(msg);
              } finally {
                setBusy(false);
              }
            }}
          >
            OK
          </button>
        </>
      }
    >
      {draft ? (
        <div className="form-grid">
          <label>Page size</label>
          <select className="select" value={draft.pageSize} onChange={(e) => setDraft({ ...draft, pageSize: e.target.value })} data-page="pageSize">
            {PAGE_SIZES.map((p) => (
              <option key={p} value={p}>
                {p.replace('PS_', '')}
              </option>
            ))}
          </select>
          <label>Orientation</label>
          <select className="select" value={draft.orientation} onChange={(e) => setDraft({ ...draft, orientation: e.target.value as PageInfo['orientation'] })}>
            <option value="landscape">Landscape</option>
            <option value="portrait">Portrait</option>
          </select>
          {draft.pageSize === 'PS_USER' && (
            <>
              <label>Custom size</label>
              <span style={{ display: 'flex', gap: 6 }}>
                <input className="input num" defaultValue={formatDistance(draft.userWidthNm, units)} onBlur={(e) => setDraft({ ...draft, userWidthNm: parseDistance(e.target.value, units) ?? draft.userWidthNm })} />
                <input className="input num" defaultValue={formatDistance(draft.userHeightNm, units)} onBlur={(e) => setDraft({ ...draft, userHeightNm: parseDistance(e.target.value, units) ?? draft.userHeightNm })} />
                <span className="unit">{units}</span>
              </span>
            </>
          )}
          {field('Drawing sheet file', 'drawingSheet')}
          {field('Title', 'title')}
          {field('Date', 'date')}
          {field('Revision', 'revision')}
          {field('Company', 'company')}
          {draft.comments.slice(0, 4).map((c, i) => (
            <div key={i} style={{ display: 'contents' }}>
              <label>Comment {i + 1}</label>
              <input className="input" value={c} onChange={(e) => setDraft({ ...draft, comments: draft.comments.map((x, j) => (j === i ? e.target.value : x)) })} data-page={`comment${i + 1}`} />
            </div>
          ))}
          {before && <div className="help">Unchanged sections are not sent.</div>}
        </div>
      ) : (
        !error && <p className="dialog-desc">Reading page settings…</p>
      )}
    </Dialog>
  );
}
