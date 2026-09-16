// Board-wide operations that KiCad performs itself rather than through a commit: the ratsnest
// counters and net lengths (`GetUnroutedCount` / `GetNetLengths`), teardrops, autoplace, global
// deletion, "update footprints from library", and the DRC/ERC severity tables.
//
// Every one of these mutates the board on the server without going through `BeginCommit`, so the
// caller re-syncs the store afterwards (`documents.resyncDocument`) and the history panel's
// server-undo mode is what can take them back.

import { BoardLayer, DrcErrorType, ErcErrorType, KiCadObjectType, RuleSeverity } from '@fp-pcb/proto';
import type { KicadDocumentService } from './KicadDocumentService';
import type { BoardToolsService, FootprintUpdateReport, GlobalDeleteOptions, NetLengthRow, RuleSeverityName, TeardropOptions, UnroutedInfo } from '../extras';

const num = (v: bigint | number | undefined): number => (typeof v === 'bigint' ? Number(v) : (v ?? 0));

const SEVERITY_TO_NAME: Record<number, RuleSeverityName> = {
  [RuleSeverity.RS_ERROR]: 'error',
  [RuleSeverity.RS_WARNING]: 'warning',
  [RuleSeverity.RS_IGNORE]: 'ignore',
};
const NAME_TO_SEVERITY: Record<RuleSeverityName, RuleSeverity> = {
  error: RuleSeverity.RS_ERROR,
  warning: RuleSeverity.RS_WARNING,
  ignore: RuleSeverity.RS_IGNORE,
};

/** `'KOT_PCB_TRACE'` -> the enum value; unknown names are dropped. */
export function objectType(name: string): KiCadObjectType | undefined {
  const v = (KiCadObjectType as unknown as Record<string, number | undefined>)[name];
  return typeof v === 'number' ? (v as KiCadObjectType) : undefined;
}

/** `'BL_F_Cu'` -> the enum value. */
export function boardLayer(name: string): BoardLayer | undefined {
  const v = (BoardLayer as unknown as Record<string, number | undefined>)[name];
  return typeof v === 'number' ? (v as BoardLayer) : undefined;
}

/** Item types `GlobalDeletion` accepts, in the order KiCad's dialog lists them. */
export const GLOBAL_DELETE_TYPES: readonly { type: string; label: string }[] = [
  { type: 'KOT_PCB_TRACE', label: 'Tracks' },
  { type: 'KOT_PCB_ARC', label: 'Track arcs' },
  { type: 'KOT_PCB_VIA', label: 'Vias' },
  { type: 'KOT_PCB_FOOTPRINT', label: 'Footprints' },
  { type: 'KOT_PCB_ZONE', label: 'Zones' },
  { type: 'KOT_PCB_SHAPE', label: 'Graphics' },
  { type: 'KOT_PCB_TEXT', label: 'Text' },
  { type: 'KOT_PCB_DIMENSION', label: 'Dimensions' },
];

export class KicadBoardTools implements BoardToolsService {
  constructor(
    private readonly docs: KicadDocumentService,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
  ) {}

  private get board() {
    const b = this.docs.boardDoc;
    if (!b) throw new Error('no board is open');
    return b;
  }

  async unrouted(): Promise<UnroutedInfo> {
    const r = await this.board.unroutedCount();
    return { unroutedCount: r.unroutedCount, unroutedNetCount: r.unroutedNetCount };
  }

  async netLengths(nets: string[] = []): Promise<NetLengthRow[]> {
    const rows = await this.board.netLengths(nets, { withDelays: true });
    const classes = new Map(this.docs.nets().map((n) => [n.name, n.netclass]));
    return rows.map((r): NetLengthRow => {
      const byLayer = r.layerLengths.map((l) => ({ layer: BoardLayer[l.layer] ?? String(l.layer), lengthNm: num(l.length?.valueNm) }));
      const name = r.net?.name ?? '';
      return {
        net: name,
        netclass: classes.get(name) ?? '',
        totalNm: byLayer.reduce((a, b) => a + b.lengthNm, 0),
        padCount: r.padCount,
        viaCount: r.viaCount,
        delayPs: num(r.totalDelayPs),
        byLayer,
      };
    });
  }

  /** Runs `fn` with the busy flag raised and re-syncs the board store afterwards. */
  private async mutate<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const release = this.docs.beginActivity();
    try {
      const r = await fn();
      await this.docs.resyncDocument('board');
      this.log(`${label}: done`);
      return r;
    } finally {
      release();
    }
  }

  setTeardrops(opts: TeardropOptions): Promise<number> {
    return this.mutate('SetTeardrops', () =>
      this.board.setTeardrops({
        vias: opts.vias ?? false,
        pthPads: opts.pthPads ?? false,
        smdPads: opts.smdPads ?? false,
        trackToTrack: opts.trackToTrack ?? false,
        roundShapesOnly: opts.roundShapesOnly ?? false,
        nets: opts.nets ?? [],
      }),
    );
  }

  removeTeardrops(): Promise<number> {
    return this.mutate('RemoveTeardrops', () => this.board.removeTeardrops());
  }

  async autoplace(ids: string[] = [], opts: { includeOffboard?: boolean } = {}): Promise<{ placedCount: number; ok: boolean; result: string }> {
    const r = await this.mutate('AutoplaceFootprints', () => this.board.autoplace(ids, opts));
    return { placedCount: r.placedCount, ok: r.ok, result: String(r.result) };
  }

  globalDeletion(opts: GlobalDeleteOptions): Promise<number> {
    const types = opts.types.map(objectType).filter((t): t is KiCadObjectType => t !== undefined);
    if (!types.length) throw new Error('pick at least one item type to delete');
    const layers = (opts.layers ?? []).map(boardLayer).filter((l): l is BoardLayer => l !== undefined);
    return this.mutate('GlobalDeletion', () =>
      this.board.globalDeletion({ types, layers, locked: opts.locked ?? 'unlocked', boardEdges: opts.boardEdges ?? false, teardrops: opts.teardrops ?? false }),
    );
  }

  async updateFootprintsFromLibrary(refs: string[] = [], opts: { onlyChanged?: boolean } = {}): Promise<FootprintUpdateReport> {
    const r = await this.mutate('UpdateFootprintsFromLibrary', () => this.board.updateFootprintsFromLibrary(refs, { onlyChanged: opts.onlyChanged ?? false }));
    return { updatedCount: r.updatedCount, unchangedCount: r.unchangedCount, missing: r.missing, messages: r.messages };
  }

  // ------------------------------------------------------------------ rule severities

  async severities(kind: 'drc' | 'erc'): Promise<{ rule: string; severity: RuleSeverityName }[]> {
    const rows =
      kind === 'drc'
        ? [...(await this.board.drc.severities())].map(([t, s]) => ({ rule: DrcErrorType[t] ?? String(t), severity: SEVERITY_TO_NAME[s] ?? 'ignore' }))
        : [...(await this.schematic.erc.severities())].map(([t, s]) => ({ rule: ErcErrorType[t] ?? String(t), severity: SEVERITY_TO_NAME[s] ?? 'ignore' }));
    return rows.filter((r) => !/UNKNOWN$/.test(r.rule)).sort((a, b) => a.rule.localeCompare(b.rule));
  }

  async setSeverities(kind: 'drc' | 'erc', changes: { rule: string; severity: RuleSeverityName }[]): Promise<void> {
    if (!changes.length) return;
    if (kind === 'drc') {
      const table = DrcErrorType as unknown as Record<string, number | undefined>;
      const pairs = changes.map((c) => [table[c.rule], NAME_TO_SEVERITY[c.severity]] as const).filter((p): p is readonly [DrcErrorType, RuleSeverity] => typeof p[0] === 'number');
      await this.board.drc.setSeverities(pairs);
    } else {
      const table = ErcErrorType as unknown as Record<string, number | undefined>;
      const pairs = changes.map((c) => [table[c.rule], NAME_TO_SEVERITY[c.severity]] as const).filter((p): p is readonly [ErcErrorType, RuleSeverity] => typeof p[0] === 'number');
      await this.schematic.erc.setSeverities(pairs);
    }
    this.log(`Set${kind.toUpperCase()}Severities: ${changes.length} rule(s) changed`);
  }

  private get schematic() {
    const s = this.docs.schematicDoc;
    if (!s) throw new Error('no schematic is open');
    return s;
  }
}

/** Human label for a `DRCET_*` / `ERCET_*` enum name. */
export function ruleLabel(name: string): string {
  return name
    .replace(/^(DRCET_|ERCET_)/, '')
    .toLowerCase()
    .replace(/_/g, ' ');
}
