// Route -> Autoroute...: pick a router (the JS router in this tab, the JS router on the bridge,
// Freerouting on the bridge), which nets and layers, via cost, passes and a time limit; watch the
// run (routed/total, elapsed, the router's log tail, Cancel); then read the summary — routed/total,
// tracks, vias, track length, wall time — with the result already on the board as one undo entry,
// a "Refill zones + run DRC" shortcut, and the unrouted connections listed (a click frames the
// airline and highlights its net). A failed or cancelled run says so and leaves the board as it was.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCanvasHost } from '@/canvas/CanvasSlot';
import { useServices, useServiceVersion } from '@/services';
import { airlineCamera, formatDuration, isFinished } from '@/services/autoroute-run';
import type { AutorouteAvailability, AutorouteRequest, AutorouteRun, AutorouterChoice } from '@/services/types';
import { useAppStore } from '@/state/appStore';
import { useEditorDoc, useEditorStore } from '@/state/editorStore';
import { log } from '@/state/logStore';
import { useUiStore } from '@/state/uiStore';
import { formatDistance } from '@/lib/units';
import { layerDisplayName } from '@/lib/enums';
import { Dialog } from '../layout/Dialog';

const ROUTERS: { value: AutorouterChoice; label: string; help: string }[] = [
  { value: 'fab-router', label: 'FabRouter', help: 'fabPlane/fab_router inside the bridge' },
  { value: 'freerouting', label: 'Freerouting, on the server', help: 'Java; slower, completes dense boards; passes bound the run, a time limit kills it with nothing routed' },
];

const STATE_LABEL: Record<AutorouteRun['state'], string> = {
  starting: 'starting',
  filling: 'refilling zones',
  saving: 'saving the board',
  extracting: 'reading the board',
  routing: 'routing',
  applying: 'applying the result',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function AutorouteDialog() {
  const dialog = useUiStore((s) => s.dialog);
  const openDialog = useUiStore((s) => s.openDialog);
  const units = useUiStore((s) => s.units);
  const { autoroute, documents, markers } = useServices();
  const subscribe = useCallback((cb: () => void) => (autoroute ? autoroute.onChange(cb) : () => undefined), [autoroute]);
  useServiceVersion(subscribe);
  const open = dialog === 'autoroute';
  const run = autoroute?.current() ?? null;
  const running = !!run && !isFinished(run);

  const doc = useEditorDoc('board');
  const store = documents.board();
  const copperLayers = useMemo(() => documents.layers().filter((l) => l.kind === 'copper'), [documents, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectedNets = useMemo(() => {
    const nets = new Set<string>(doc.highlightNets);
    if (store)
      for (const id of doc.selection) {
        const it = store.get(id);
        if (it?.net) nets.add(it.net);
        if (it?.type === 'KOT_PCB_FOOTPRINT') for (const child of store.all()) if (child.parent === id && child.net) nets.add(child.net);
      }
    return [...nets];
  }, [doc.selection, doc.highlightNets, store]);

  const [router, setRouter] = useState<AutorouterChoice>('fab-router');
  const [netScope, setNetScope] = useState<'all' | 'selected'>('all');
  const [layers, setLayers] = useState<string[]>([]);
  const [viaCost, setViaCost] = useState(1);
  const [passes, setPasses] = useState<Record<AutorouterChoice, number>>({ 'js-tab': 1, 'fab-router': 1, freerouting: 20 });
  const [timeLimitS, setTimeLimitS] = useState<Record<AutorouterChoice, number>>({ 'js-tab': 300, 'fab-router': 600, freerouting: 0 });
  const [refill, setRefill] = useState(true);
  const [availability, setAvailability] = useState<AutorouteAvailability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(true);
  const [tick, setTick] = useState(0);
  const [drc, setDrc] = useState<{ busy: boolean; result?: string; error?: string }>({ busy: false });

  useEffect(() => {
    if (!open) return;
    setLayers(copperLayers.map((l) => l.id));
    setError(null);
    setDrc({ busy: false });
    setShowForm(!run || isFinished(run));
    if (autoroute) void autoroute.available().then(setAvailability);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, [running]);
  void tick;

  const request = (): AutorouteRequest => ({
    router,
    nets: netScope === 'selected' ? selectedNets : undefined,
    layers: layers.length === copperLayers.length ? undefined : layers,
    viaCost,
    passes: passes[router],
    timeLimitMs: timeLimitS[router] > 0 ? timeLimitS[router] * 1000 : undefined,
    refillZones: refill,
  });

  const start = async () => {
    if (!autoroute) return;
    setError(null);
    setShowForm(false);
    setDrc({ busy: false });
    try {
      const r = await autoroute.start(request());
      if (r.state === 'done' && r.summary) useAppStore.getState().notify(`Autoroute: ${r.summary.routed} of ${r.summary.total} connections routed`);
      else if (r.state === 'failed') useAppStore.getState().notify(`Autoroute failed: ${r.error ?? 'unknown error'}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setShowForm(true);
    }
  };

  const focusAirline = (c: { net: string; from: { x: number; y: number }; to: { x: number; y: number } }) => {
    const host = getCanvasHost('board');
    const el = document.querySelector('canvas[aria-label="board canvas"]');
    const size = el ? { width: (el as HTMLCanvasElement).clientWidth, height: (el as HTMLCanvasElement).clientHeight } : { width: 800, height: 600 };
    host?.setCamera(airlineCamera(c, size));
    useEditorStore.getState().setHighlightNets('board', [c.net]);
    useUiStore.getState().setRatsnest(true);
  };

  const runDrc = async () => {
    setDrc({ busy: true });
    try {
      const refillZones = (documents as { refillZones?: () => Promise<void> }).refillZones;
      if (refillZones) await refillZones.call(documents);
      useUiStore.getState().setBottomTab('markers');
      const list = await markers.run('drc');
      const live = list.filter((m) => !m.excluded);
      const errors = live.filter((m) => m.severity === 'error');
      const unconnected = errors.filter((m) => /unconnected/i.test(m.rule)).length;
      const warnings = live.filter((m) => m.severity === 'warning').length;
      const text = `${errors.length - unconnected} error${errors.length - unconnected === 1 ? '' : 's'}, ${unconnected} unconnected, ${warnings} warning${warnings === 1 ? '' : 's'}`;
      setDrc({ busy: false, result: text });
      log(`Autoroute → DRC: ${text}`);
    } catch (e) {
      setDrc({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const toggleLayer = (id: string) => setLayers((ls) => (ls.includes(id) ? ls.filter((l) => l !== id) : [...ls, id]));
  const freeroutingReason = availability && !availability.freerouting.ok ? availability.freerouting.reason : undefined;
  const serverReason = availability && !availability.server ? 'the bridge job route is not reachable from this tab' : undefined;
  const fabRouterReason = availability && !availability.fabRouter.ok ? availability.fabRouter.reason : undefined;
  const routerDisabled = (r: AutorouterChoice) => (r === 'freerouting' ? !!freeroutingReason : r === 'fab-router' ? !!(serverReason || fabRouterReason) : false);
  const elapsed = run ? (run.finishedAt ?? Date.now()) - run.startedAt : 0;
  const percent = run?.progress?.percent;
  const summary = run?.summary;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && openDialog(null)}
      title="Autoroute"
      description="Routes the unrouted connections and applies the result as one undo step (History: “Autoroute (…): n connections”)."
      size="wide"
      footer={
        <>
          {run && !showForm && !running && (
            <button className="btn" onClick={() => setShowForm(true)} data-testid="autoroute-again">
              New run…
            </button>
          )}
          {summary && !showForm && (
            <button className="btn" onClick={() => void runDrc()} disabled={drc.busy} data-testid="autoroute-drc" title="RefillZones, then RunBoardJobDrc; the markers panel shows the result">
              {drc.busy ? 'Running DRC…' : 'Refill zones + run DRC'}
            </button>
          )}
          <span className="spacer" />
          {running ? (
            <button className="btn danger" onClick={() => void autoroute?.cancel()} data-testid="autoroute-cancel">
              Cancel
            </button>
          ) : (
            <button className="btn" onClick={() => openDialog(null)}>
              Close
            </button>
          )}
          {showForm && (
            <button
              className="btn primary"
              disabled={!autoroute || running || !store || routerDisabled(router) || (netScope === 'selected' && selectedNets.length === 0)}
              onClick={() => void start()}
              data-testid="autoroute-run"
            >
              Route
            </button>
          )}
        </>
      }
    >
      {!autoroute && <div className="empty-state">Autorouting needs the KiCad services (the mock has no router).</div>}
      {autoroute && showForm && (
        <div className="form-grid">
          <label htmlFor="autoroute-router">Router</label>
          <select id="autoroute-router" data-testid="autoroute-router" className="select" value={router} onChange={(e) => setRouter(e.target.value as AutorouterChoice)}>
            {ROUTERS.map((r) => (
              <option key={r.value} value={r.value} disabled={routerDisabled(r.value)}>
                {r.label}
                {routerDisabled(r.value) ? ' (unavailable)' : ''}
              </option>
            ))}
          </select>
          <span className="help">
            {ROUTERS.find((r) => r.value === router)?.help}
            {router === 'freerouting' && freeroutingReason ? ` — ${freeroutingReason}` : ''}
            {router === 'fab-router' && (serverReason || fabRouterReason) ? ` — ${serverReason || fabRouterReason}` : ''}
          </span>

          <label htmlFor="autoroute-nets">Nets</label>
          <select id="autoroute-nets" data-testid="autoroute-nets" className="select" value={netScope} onChange={(e) => setNetScope(e.target.value as 'all' | 'selected')}>
            <option value="all">All unrouted connections</option>
            <option value="selected">Selected nets ({selectedNets.length})</option>
          </select>
          <span className="help">
            {netScope === 'selected'
              ? selectedNets.length
                ? selectedNets.slice(0, 8).join(', ') + (selectedNets.length > 8 ? ', …' : '')
                : 'select items or highlight a net first'
              : 'every airline of the ratsnest'}
          </span>

          <label>Layers</label>
          <span className="autoroute-layers" data-testid="autoroute-layers">
            {copperLayers.map((l) => (
              <label key={l.id} className="chip-check">
                <input type="checkbox" className="checkbox" checked={layers.includes(l.id)} onChange={() => toggleLayer(l.id)} /> {l.name || layerDisplayName(l.id)}
              </label>
            ))}
          </span>
          <span className="help">
            {router === 'freerouting' ? "Freerouting gets every enabled copper layer from KiCad's exporter; the choice is logged" : 'the JS router routes only on the ticked layers'}
          </span>

          <label htmlFor="autoroute-viacost">Via cost</label>
          <input id="autoroute-viacost" data-testid="autoroute-viacost" className="input" type="number" min={0} step={0.5} value={viaCost} onChange={(e) => setViaCost(Number(e.target.value))} />
          <span className="help">relative to 1 mm of track; neither router exposes the knob on its API yet, the value is logged</span>

          <label htmlFor="autoroute-passes">{router === 'freerouting' ? 'Passes (-mp)' : 'Effort'}</label>
          <input
            id="autoroute-passes"
            data-testid="autoroute-passes"
            className="input"
            type="number"
            min={1}
            value={passes[router]}
            onChange={(e) => setPasses({ ...passes, [router]: Math.max(1, Number(e.target.value) || 1) })}
          />
          <span className="help">{router === 'freerouting' ? 'maximum auto-routing passes; ~20 finishes a medium board in a few minutes, 100 is Freerouting’s default' : 'FabRouter effort'}</span>

          <label htmlFor="autoroute-time">Time limit (s)</label>
          <input
            id="autoroute-time"
            data-testid="autoroute-time"
            className="input"
            type="number"
            min={0}
            value={timeLimitS[router]}
            onChange={(e) => setTimeLimitS({ ...timeLimitS, [router]: Math.max(0, Number(e.target.value) || 0) })}
          />
          <span className="help">
            {router === 'freerouting' ? '0 = none. Freerouting has no stop-and-save: hitting the limit kills it and nothing is applied' : '0 = none; forwarded to FabRouter as its total time budget'}
          </span>

          <label htmlFor="autoroute-refill">Refill zones first</label>
          <span>
            <input id="autoroute-refill" type="checkbox" className="checkbox" checked={refill} onChange={(e) => setRefill(e.target.checked)} />{' '}
            <span className="help">so pads a copper pour already connects are not routed with tracks</span>
          </span>
          {error && (
            <div className="empty-state" style={{ gridColumn: '1 / -1', color: 'var(--danger)' }} role="alert" data-testid="autoroute-error">
              {error}
            </div>
          )}
        </div>
      )}

      {autoroute && run && !showForm && (
        <div className="autoroute-run" data-testid="autoroute-progress" data-state={run.state}>
          <div className="autoroute-status">
            <span className={`chip on state-${run.state}`} data-testid="autoroute-state">
              {STATE_LABEL[run.state]}
            </span>
            <span className="muted">
              {ROUTERS.find((r) => r.value === run.request.router)?.label}
              {run.progress?.phase ? ` · ${run.progress.phase}` : ''}
              {run.progress?.routed !== undefined && run.progress?.total ? ` · ${run.progress.routed} / ${run.progress.total} routed` : ''}
              {' · '}
              {formatDuration(elapsed)}
            </span>
          </div>
          {running && (
            <div className="progress">
              <div style={{ width: `${percent ?? 0}%` }} />
            </div>
          )}
          {run.state === 'failed' && (
            <div className="report" role="alert" data-testid="autoroute-error">
              <p>
                <strong>Routing failed:</strong> {run.error}
              </p>
              <p className="muted">The board was left as it was; nothing was applied.</p>
            </div>
          )}
          {run.state === 'cancelled' && (
            <div className="report" role="alert" data-testid="autoroute-error">
              <p>
                <strong>Cancelled</strong>
                {run.error && run.error !== 'cancelled' ? ` — ${run.error}` : ''}
              </p>
              <p className="muted">The board was left as it was; nothing was applied.</p>
            </div>
          )}
          {summary && run.state === 'done' && (
            <div className="report" data-testid="autoroute-summary">
              <div className="autoroute-summary">
                <div>
                  <span className="faint">routed</span> <strong data-testid="autoroute-routed">{summary.routed}</strong> / {summary.total}
                  {summary.routerRouted !== undefined && summary.routerRouted !== summary.routed ? (
                    <span className="muted" title="A net counts as routed for the router once it got a wire; KiCad's ratsnest after the apply is what is shown">
                      {' '}
                      (router said {summary.routerRouted})
                    </span>
                  ) : null}
                  {summary.unroutedAfter !== undefined && summary.unroutedAfter !== summary.total - summary.routed ? (
                    <span className="muted"> · {summary.unroutedAfter} unrouted on the whole board</span>
                  ) : null}
                </div>
                <div>
                  <span className="faint">tracks</span> <strong>{summary.tracks}</strong>
                </div>
                <div>
                  <span className="faint">vias</span> <strong>{summary.vias}</strong>
                </div>
                <div>
                  <span className="faint">track length</span> <strong>{summary.trackLengthNm ? formatDistance(summary.trackLengthNm, units, units === 'mm' ? 1 : 2) + ' ' + units : '—'}</strong>
                </div>
                <div>
                  <span className="faint">wall time</span> <strong>{formatDuration(summary.wallMs)}</strong>
                  <span className="muted"> (router {formatDuration(summary.elapsedMs)})</span>
                </div>
                <div>
                  <span className="faint">router</span> <strong>{summary.router}</strong>
                  {summary.timedOut ? <span className="muted"> · timed out</span> : null}
                </div>
              </div>
              <p className="muted">
                {summary.message ? (
                  <>
                    Applied as one undo entry: <em>{summary.message}</em>
                  </>
                ) : (
                  'Nothing was applied (no tracks or vias came back).'
                )}
                {drc.result ? ` · DRC: ${drc.result}` : ''}
                {drc.error ? ` · DRC failed: ${drc.error}` : ''}
              </p>
              {summary.unrouted.length > 0 && (
                <div className="autoroute-unrouted">
                  <div className="muted">{summary.unrouted.length} unrouted connection(s) — click one to frame it:</div>
                  <div className="autoroute-unrouted-list">
                    {summary.unrouted.map((c, i) => (
                      <button
                        key={i}
                        className="btn ghost sm autoroute-unrouted-row"
                        data-testid="autoroute-unrouted-row"
                        onClick={() => focusAirline(c)}
                        title={`${c.net}: (${(c.from.x / 1e6).toFixed(2)}, ${(c.from.y / 1e6).toFixed(2)}) → (${(c.to.x / 1e6).toFixed(2)}, ${(c.to.y / 1e6).toFixed(2)}) mm`}
                      >
                        <span className="net">{c.net}</span>
                        <span className="muted">
                          {formatDistance(Math.hypot(c.to.x - c.from.x, c.to.y - c.from.y), units)} {units}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {run.log.length > 0 && (
            <pre className="log-lines autoroute-log" data-testid="autoroute-log">
              {(running ? run.log.slice(-10) : run.log).join('\n')}
            </pre>
          )}
        </div>
      )}
    </Dialog>
  );
}
