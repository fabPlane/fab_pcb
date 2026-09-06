import { mm } from '@/lib/units';
import type { Marker, MarkerService } from '../types';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fake DRC/ERC. Until gap G4 (RunBoardJobDrc / RunSchematicJobErc headless) lands, the
 * real service will parse the report JSON the job returns into the same Marker shape.
 */
export class MockMarkerService implements MarkerService {
  private byKind: Record<'drc' | 'erc', Marker[]> = { drc: [], erc: [] };
  private runs: Record<'drc' | 'erc', number | null> = { drc: null, erc: null };
  private subs = new Set<() => void>();

  constructor(
    private readonly boardIds: Record<string, string>,
    private readonly schIds: Record<string, string>,
    private readonly latencyMs = 250,
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

  setExcluded(id: string, excluded: boolean): void {
    for (const kind of ['drc', 'erc'] as const) {
      this.byKind[kind] = this.byKind[kind].map((m) => (m.id === id ? { ...m, excluded } : m));
    }
    this.emit();
  }

  async run(kind: 'drc' | 'erc'): Promise<Marker[]> {
    await delay(this.latencyMs);
    const b = this.boardIds;
    const s = this.schIds;
    const list: Marker[] =
      kind === 'drc'
        ? [
            { id: 'drc-1', kind, severity: 'error', rule: 'clearance', message: 'Clearance violation (netclass Default clearance 0.2000 mm; actual 0.1421 mm)', items: [b.t3!, b['U1.1']!], position: { x: mm(26.2), y: mm(13.1) }, excluded: false },
            { id: 'drc-2', kind, severity: 'error', rule: 'unconnected_items', message: 'Missing connection between items: pad 4 of U1 [GND] and zone GND pour', items: [b['U1.4']!, b.zoneGND!], position: { x: mm(26.4), y: mm(16.905) }, excluded: false },
            { id: 'drc-3', kind, severity: 'error', rule: 'unconnected_items', message: 'Missing connection between items: pad 2 of C1 [GND] and pad 2 of J1 [GND]', items: [b['C1.2']!, b['J1.2']!], position: { x: mm(12), y: mm(20.775) }, excluded: false },
            { id: 'drc-4', kind, severity: 'warning', rule: 'silk_over_copper', message: 'Silkscreen clipped by solder mask (F.Silkscreen text overlaps pad 8 of U1)', items: [b.title!, b['U1.8']!], position: { x: mm(33.6), y: mm(13.1) }, excluded: false },
            { id: 'drc-5', kind, severity: 'warning', rule: 'track_dangling', message: 'Track has unconnected end', items: [b.t13!], position: { x: mm(45), y: mm(30) }, excluded: false },
            { id: 'drc-6', kind, severity: 'warning', rule: 'lib_footprint_mismatch', message: "Footprint 'Package_SO:SOIC-8_5.3x5.3mm_P1.27mm' doesn't match copy in library", items: [b.U1!], position: { x: mm(30), y: mm(15) }, excluded: true },
            { id: 'drc-7', kind, severity: 'info', rule: 'copper_edge_clearance', message: 'Board edge clearance 0.5000 mm satisfied everywhere (min actual 0.9000 mm)', items: [], position: { x: mm(1), y: mm(1) }, excluded: false },
          ]
        : [
            { id: 'erc-1', kind, severity: 'error', rule: 'pin_not_connected', message: 'Pin 7 (PB2) of U1 is unconnected (bidirectional)', items: [s.U1!], position: { x: mm(59.84), y: mm(51.27) }, sheetPath: '/', excluded: false },
            { id: 'erc-2', kind, severity: 'error', rule: 'hier_label_mismatch', message: "Hierarchical label 'PB2' has no matching sheet pin in the parent sheet", items: [s.lbl_pb2!], position: { x: mm(59.84), y: mm(51.27) }, sheetPath: '/', excluded: false },
            { id: 'erc-3', kind, severity: 'warning', rule: 'label_dangling', message: "Label 'SIG' is not connected to anything", items: [s.lbl_sig!], position: { x: mm(42), y: mm(50) }, sheetPath: '/', excluded: false },
            { id: 'erc-4', kind, severity: 'warning', rule: 'power_pin_not_driven', message: 'Input power pin 8 (VCC) of U1 not driven by any output power pin', items: [s.U1!], position: { x: mm(70), y: mm(42.38) }, sheetPath: '/', excluded: false },
            { id: 'erc-5', kind, severity: 'warning', rule: 'global_label_dangling', message: "Global label 'VIN' is used only once", items: [s.lbl_vin!], position: { x: mm(94.92), y: mm(51.27) }, sheetPath: '/', excluded: false },
            { id: 'erc-6', kind, severity: 'error', rule: 'no_connect_connected', message: 'Pin 4 of J1 has a no-connect marker but is also wired', items: [s.J1!], position: { x: mm(94.92), y: mm(53.81) }, sheetPath: '/', excluded: false },
            { id: 'erc-7', kind, severity: 'warning', rule: 'lib_symbol_mismatch', message: "Symbol 'Regulator_Linear:AMS1117-3.3' differs from the library copy", items: [s.U2!], position: { x: mm(50), y: mm(40) }, sheetPath: `/${s.sheetPower ?? ''}/`, excluded: false },
          ];
    this.byKind[kind] = list;
    this.runs[kind] = Date.now();
    this.emit();
    return list;
  }
}
