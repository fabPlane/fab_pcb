// The schematic workflow KiCad performs server-side: Annotate / ClearAnnotation,
// SyncSchematicToBoard (the netlist updater, with its report), the symbol fields table
// (GetSymbolFieldsTable / SetSymbolFields) and AssignFootprints.
//
// All of these change the document outside a client commit, so each one re-syncs the schematic
// stores (and the board too, for `syncToBoard`) through `documents.afterCommit`.

import type { SheetPath } from '@fp-pcb/proto';
import type { KicadDocumentService } from './KicadDocumentService';
import type { AnnotateOptions, AnnotateReport, FieldEditInput, FieldsRow, FieldsTable, SchematicToolsService, SyncOptions, SyncReport } from '../extras';

/** Columns KiCad always has, in the order the grid shows them. */
export const MANDATORY_FIELDS = ['Reference', 'Value', 'Footprint', 'Datasheet', 'Description'];

export class KicadSchematicTools implements SchematicToolsService {
  /**
   * Sheet path per row of the last `fieldsTable()`. `SetSymbolFields` needs it for Reference /
   * Value / Footprint, which are per placement rather than per symbol.
   */
  private sheetPaths = new Map<string, SheetPath | undefined>();

  constructor(
    private readonly docs: KicadDocumentService,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
  ) {}

  private get sch() {
    const s = this.docs.schematicDoc;
    if (!s) throw new Error('no schematic is open');
    return s;
  }

  private async mutate<T>(label: string, fn: () => Promise<T>, alsoBoard = false): Promise<T> {
    const release = this.docs.beginActivity();
    try {
      const r = await fn();
      await this.docs.resyncDocument('schematic');
      if (alsoBoard && this.docs.boardDoc) await this.docs.resyncDocument('board');
      this.log(`${label}: done`);
      return r;
    } finally {
      release();
    }
  }

  async annotate(opts: AnnotateOptions): Promise<AnnotateReport> {
    const r = await this.mutate('Annotate', () =>
      this.sch.annotate({
        scope: opts.scope,
        items: opts.items,
        sheetPath: opts.sheetPath && opts.sheetPath !== '/' ? opts.sheetPath : undefined,
        sortOrder: opts.sortOrder,
        numbering: opts.numbering,
        startNumber: opts.startNumber,
        resetExisting: opts.resetExisting,
        recursive: opts.recursive,
      }),
    );
    return { annotatedCount: r.annotatedCount, symbolCount: r.symbolCount, errorCount: r.errorCount, messages: r.messages };
  }

  async clearAnnotation(opts: Pick<AnnotateOptions, 'scope' | 'items' | 'recursive'>): Promise<AnnotateReport> {
    const r = await this.mutate('ClearAnnotation', () => this.sch.clearAnnotation(opts.scope, { items: opts.items, recursive: opts.recursive }));
    return { annotatedCount: r.annotatedCount, symbolCount: r.symbolCount, errorCount: r.errorCount, messages: r.messages };
  }

  async syncToBoard(opts: SyncOptions = {}): Promise<SyncReport> {
    const board = this.docs.boardDoc;
    if (!board) throw new Error('no board is open — "Update PCB from schematic" needs both documents');
    const dryRun = opts.dryRun ?? false;
    const r = await this.mutate(
      dryRun ? 'SyncSchematicToBoard (dry run)' : 'SyncSchematicToBoard',
      () =>
        this.sch.syncToBoard(board, {
          dryRun,
          matchMode: opts.matchMode ?? 'uuid',
          deleteExtraFootprints: opts.deleteExtraFootprints ?? false,
          updateFootprints: opts.updateFootprints ?? true,
          updateFields: opts.updateFields ?? true,
          removeExtraFields: opts.removeExtraFields ?? false,
        }),
      !dryRun,
    );
    return { errorCount: r.errorCount, warningCount: r.warningCount, newFootprintCount: r.newFootprintCount, report: r.report, dryRun };
  }

  async fieldsTable(opts: { includePowerSymbols?: boolean } = {}): Promise<FieldsTable> {
    const rows = await this.sch.fieldsTable({ includePowerSymbols: opts.includePowerSymbols ?? false });
    const seen = new Set<string>();
    this.sheetPaths.clear();
    const out: FieldsRow[] = rows.map((r) => {
      for (const k of Object.keys(r.fields)) seen.add(k);
      this.sheetPaths.set(r.id, r.sheetPath);
      return {
        id: r.id,
        sheet: r.sheet || '/',
        reference: r.reference,
        unit: r.unit,
        fields: { ...r.fields },
        excludedFromBom: r.excludedFromBom,
        excludedFromBoard: r.excludedFromBoard,
        doNotPopulate: r.doNotPopulate,
      };
    });
    const extra = [...seen].filter((k) => !MANDATORY_FIELDS.includes(k)).sort();
    this.log(`GetSymbolFieldsTable: ${out.length} placements, ${MANDATORY_FIELDS.length + extra.length} columns`);
    return { rows: out, columns: [...MANDATORY_FIELDS, ...extra] };
  }

  /** One `SetSymbolFields` call for every pending edit, so the grid commits in a single step. */
  async setFields(edits: FieldEditInput[]): Promise<{ updatedCount: number; errors: string[] }> {
    if (!edits.length) return { updatedCount: 0, errors: [] };
    const r = await this.mutate('SetSymbolFields', () => this.sch.setFields(edits.map((e) => ({ id: e.id, field: e.field, value: e.value, sheetPath: this.sheetPaths.get(e.id) }))));
    return { updatedCount: r.updatedCount, errors: r.errors };
  }

  async assignFootprints(assignments: { reference: string; footprint: string }[]): Promise<{ assignedCount: number; unmatchedReferences: string[] }> {
    if (!assignments.length) return { assignedCount: 0, unmatchedReferences: [] };
    const r = await this.mutate('AssignFootprints', () => this.sch.assignFootprints(assignments));
    return { assignedCount: r.assignedCount, unmatchedReferences: r.unmatchedReferences };
  }
}
