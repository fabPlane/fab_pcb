// MarkerService over RunBoardJobDrc / GetDrcMarkers / SetDrcMarkerExcluded and their ERC
// twins. The commands exist only on the web-api KiCad fork; `client.capabilities()` (from
// GetSupportedCommands, which lists the handlers created for the open documents) decides
// whether a check is offered, otherwise `run()` rejects with "not supported by this server".
//
// The commands are called through `client.call()` with the generated schemas because the
// client's typed command table predates them.

import {
  DrcErrorType,
  DrcResultsResponseSchema,
  ErcErrorType,
  ErcResultsResponseSchema,
  GetDrcMarkersSchema,
  GetErcMarkersSchema,
  RuleSeverity,
  RunBoardJobDrcSchema,
  RunSchematicJobErcSchema,
  SetDrcMarkerExcludedSchema,
  SetErcMarkerExcludedSchema,
  type DrcMarker,
  type ErcMarker,
} from '@fp-pcb/proto';
import { KiCadApiError, TransportError } from '@fp-pcb/client';
import type { Marker, MarkerService, MarkerSeverity } from '../types';
import type { KicadDocumentService } from './KicadDocumentService';

const num = (v: bigint | number | undefined): number => (typeof v === 'bigint' ? Number(v) : (v ?? 0));

function severity(s: RuleSeverity): MarkerSeverity {
  switch (s) {
    case RuleSeverity.RS_ERROR:
      return 'error';
    case RuleSeverity.RS_WARNING:
      return 'warning';
    default:
      return 'info';
  }
}

const ruleName = (name: string | undefined, prefix: string): string => (name ?? 'unknown').replace(prefix, '').toLowerCase();

function fromDrc(m: DrcMarker): Marker {
  return {
    id: m.id?.value || crypto.randomUUID(),
    kind: 'drc',
    severity: severity(m.severity),
    rule: ruleName(DrcErrorType[m.errorType], 'DRCET_'),
    message: m.description,
    items: m.items.map((k) => k.value),
    position: { x: num(m.position?.xNm), y: num(m.position?.yNm) },
    excluded: m.excluded,
    comment: m.exclusionComment ?? '',
  };
}

function fromErc(m: ErcMarker): Marker {
  return {
    id: m.id?.value || crypto.randomUUID(),
    kind: 'erc',
    severity: severity(m.severity),
    rule: ruleName(ErcErrorType[m.errorType], 'ERCET_'),
    message: m.description,
    items: m.items.map((k) => k.value),
    position: { x: num(m.position?.xNm), y: num(m.position?.yNm) },
    sheetPath: m.sheetSpecificPath ? `/${m.sheetSpecificPath.path.map((k) => k.value).join('/')}` : undefined,
    excluded: m.excluded,
    comment: m.exclusionComment ?? '',
  };
}

export class KicadMarkerService implements MarkerService {
  private byKind: Record<'drc' | 'erc', Marker[]> = { drc: [], erc: [] };
  private runs: Record<'drc' | 'erc', number | null> = { drc: null, erc: null };
  private subs = new Set<() => void>();

  constructor(
    private readonly docs: KicadDocumentService,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
  ) {}

  markers(kind: 'drc' | 'erc'): Marker[] {
    return this.byKind[kind];
  }

  lastRun(kind: 'drc' | 'erc'): number | null {
    return this.runs[kind];
  }

  onChange(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  private emit(): void {
    for (const cb of this.subs) cb();
  }

  /** Whether the server advertises the check (`GetSupportedCommands`). */
  async supports(kind: 'drc' | 'erc'): Promise<boolean> {
    const kicad = this.docs.kicad;
    if (!kicad) return false;
    const caps = await kicad.capabilities();
    const cmd = kind === 'drc' ? 'RunBoardJobDrc' : 'RunSchematicJobErc';
    const cap = caps.get(cmd);
    return caps.source === 'server' ? !!cap && cap.headless : false;
  }

  async run(kind: 'drc' | 'erc'): Promise<Marker[]> {
    const kicad = this.docs.kicad;
    if (!kicad) throw new Error('not connected');
    const cmd = kind === 'drc' ? 'RunBoardJobDrc' : 'RunSchematicJobErc';
    if (!(await this.supports(kind))) throw new Error(`${kind.toUpperCase()} is not supported by this server (${cmd} is not advertised by GetSupportedCommands)`);
    const release = this.docs.beginActivity();
    try {
      let list: Marker[];
      if (kind === 'drc') {
        const board = this.docs.boardDoc;
        if (!board) throw new Error('no board is open');
        const res = await kicad.client.call(RunBoardJobDrcSchema, { board: board.specifier, refillZones: false, reportAllTrackErrors: false }, DrcResultsResponseSchema, {
          command: cmd,
          timeoutMs: 120_000,
        });
        list = res.markers.map(fromDrc);
      } else {
        const sch = this.docs.schematicDoc;
        if (!sch) throw new Error('no schematic is open');
        // KiCad 10.99.0-3665 never answers RunSchematicJobErc headless (the server wedges);
        // a short timeout turns that into a visible error instead of a hung panel.
        const res = await kicad.client.call(RunSchematicJobErcSchema, { schematic: sch.specifier }, ErcResultsResponseSchema, { command: cmd, timeoutMs: 30_000, retry: false });
        list = res.markers.map(fromErc);
      }
      this.byKind[kind] = list;
      this.runs[kind] = Date.now();
      this.emit();
      this.log(`${cmd}: ${list.length} markers`);
      return list;
    } catch (e) {
      if (e instanceof KiCadApiError && e.isUnsupported) throw new Error(`${kind.toUpperCase()} is not supported by this server (${e.codeName})`);
      if (e instanceof TransportError && e.code === 'timeout')
        throw new Error(`${cmd} did not answer in time; the KiCad server is probably wedged (known headless bug) - reopen the project to restart it`);
      throw e;
    } finally {
      release();
    }
  }

  /** Re-reads the markers KiCad holds without running the checker. */
  async refresh(kind: 'drc' | 'erc'): Promise<Marker[]> {
    const kicad = this.docs.kicad;
    if (!kicad) return [];
    if (kind === 'drc' && this.docs.boardDoc) {
      const res = await kicad.client.call(GetDrcMarkersSchema, { board: this.docs.boardDoc.specifier }, DrcResultsResponseSchema, { command: 'GetDrcMarkers' });
      this.byKind.drc = res.markers.map(fromDrc);
    } else if (kind === 'erc' && this.docs.schematicDoc) {
      const res = await kicad.client.call(GetErcMarkersSchema, { schematic: this.docs.schematicDoc.specifier }, ErcResultsResponseSchema, { command: 'GetErcMarkers' });
      this.byKind.erc = res.markers.map(fromErc);
    }
    this.emit();
    return this.byKind[kind];
  }

  setExcluded(id: string, excluded: boolean): void {
    void this.setExcludedWithComment(id, excluded, '').catch(() => undefined);
  }

  /**
   * Exclusion with KiCad's comment field. The comment is stored with the project, so it survives
   * the run that rebuilt the marker ids; the local copy is updated optimistically.
   */
  async setExcludedWithComment(id: string, excluded: boolean, comment: string): Promise<void> {
    const kicad = this.docs.kicad;
    const pending: Promise<unknown>[] = [];
    for (const kind of ['drc', 'erc'] as const) {
      if (!this.byKind[kind].some((m) => m.id === id)) continue;
      this.byKind[kind] = this.byKind[kind].map((m) => (m.id === id ? { ...m, excluded, comment: excluded ? comment : '' } : m));
      if (!kicad) continue;
      if (kind === 'drc' && this.docs.boardDoc) {
        pending.push(
          kicad.client.call(SetDrcMarkerExcludedSchema, { board: this.docs.boardDoc.specifier, markers: [{ value: id }], excluded, comment }, DrcResultsResponseSchema, {
            command: 'SetDrcMarkerExcluded',
          }),
        );
      } else if (kind === 'erc' && this.docs.schematicDoc) {
        pending.push(
          kicad.client.call(SetErcMarkerExcludedSchema, { schematic: this.docs.schematicDoc.specifier, markers: [{ value: id }], excluded, comment }, ErcResultsResponseSchema, {
            command: 'SetErcMarkerExcluded',
          }),
        );
      }
    }
    this.emit();
    try {
      await Promise.all(pending);
    } catch (e) {
      this.log(`SetMarkerExcluded failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
      throw e;
    }
  }
}
