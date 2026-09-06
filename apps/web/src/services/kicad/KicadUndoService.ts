// Undo / redo through KiCad when the server implements it (`Undo` / `Redo` / `GetUndoStack`,
// advertised by GetSupportedCommands), falling back to the app's client-side history otherwise.
//
// The client's `DocumentUndo` owns the choice; this wrapper picks the document that is active in
// the UI, re-syncs its store after a server step (KiCad's undo also reverts what never passed
// through a commit — zone fills, connectivity, origins) and keeps the client `CommandService`
// history in step so a later downgrade still has something to replay.
//
// One subtlety: on the server path the client history is *not* rewound. KiCad's stack is the
// authority, and its entries are what the history panel shows.

import { DocumentUndo } from '@kicad-web/client/store';
import type { Board, Schematic } from '@kicad-web/client';
import type { CommandService, ServerUndoService, ServerUndoStacks } from '../types';
import type { KicadDocumentService } from './KicadDocumentService';

type Doc = Board | Schematic;

export class KicadUndoService implements ServerUndoService {
  private undos = new WeakMap<object, DocumentUndo>();
  private probed: 'server' | 'client' | undefined;
  private subs = new Set<() => void>();

  constructor(
    private readonly docs: KicadDocumentService,
    private readonly commands: CommandService,
    /** Which editor the user is in; undo applies to that document. */
    private readonly activeKind: () => 'board' | 'schematic' | null,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
  ) {}

  onChange(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  private emit(): void {
    for (const cb of this.subs) cb();
  }

  /** The document undo/redo applies to: whichever editor the user is in, board otherwise. */
  private active(): { doc: Doc; kind: 'board' | 'schematic' } | null {
    const kind = this.activeKind() ?? (this.docs.boardDoc ? 'board' : this.docs.schematicDoc ? 'schematic' : null);
    if (kind === 'board' && this.docs.boardDoc) return { doc: this.docs.boardDoc, kind };
    if (kind === 'schematic' && this.docs.schematicDoc) return { doc: this.docs.schematicDoc, kind };
    return null;
  }

  /** `DocumentUndo` for a document. The client stack stays empty here: the app's own
   * `CommandService` is the client-side fallback, so only the server path is delegated. */
  private undoFor(doc: Doc): DocumentUndo {
    let u = this.undos.get(doc as unknown as object);
    if (!u) {
      u = new DocumentUndo(NO_CLIENT_STACK, doc);
      this.undos.set(doc as unknown as object, u);
    }
    return u;
  }

  cachedMode(): 'server' | 'client' | undefined {
    return this.probed;
  }

  async mode(): Promise<'server' | 'client'> {
    const a = this.active();
    if (!a) return 'client';
    try {
      const server = await this.undoFor(a.doc).useServer();
      const next = server ? 'server' : 'client';
      if (next !== this.probed) {
        this.probed = next;
        this.log(`undo: ${next === 'server' ? "KiCad's own undo stack (Undo / Redo / GetUndoStack)" : 'client-side patch history'}`);
        this.emit();
      }
      return next;
    } catch {
      this.probed = 'client';
      return 'client';
    }
  }

  async stacks(): Promise<ServerUndoStacks> {
    const a = this.active();
    if (!a || (await this.mode()) !== 'server') return { undo: [], redo: [] };
    const s = await a.doc.undoStack();
    const row = (e: { description: string; clientName: string; itemCount: number }) => ({ description: e.description, clientName: e.clientName, itemCount: e.itemCount });
    return { undo: s.undo.map(row), redo: s.redo.map(row) };
  }

  undo(): Promise<{ via: 'server' | 'client' | 'none'; applied: number; label?: string }> {
    return this.step('undo');
  }

  redo(): Promise<{ via: 'server' | 'client' | 'none'; applied: number; label?: string }> {
    return this.step('redo');
  }

  private async step(dir: 'undo' | 'redo'): Promise<{ via: 'server' | 'client' | 'none'; applied: number; label?: string }> {
    const a = this.active();
    if (a && (await this.mode()) === 'server') {
      const before = await a.doc.undoStack().catch(() => null);
      const top = dir === 'undo' ? before?.undo[before.undo.length - 1] : before?.redo[before.redo.length - 1];
      const label = top?.description;
      const release = this.docs.beginActivity();
      try {
        const r = await this.undoFor(a.doc)[dir](1);
        // KiCad's undo can touch anything, so re-read the document rather than trusting a diff.
        await this.docs.resyncDocument(a.kind);
        this.emit();
        this.log(`${dir === 'undo' ? 'Undo' : 'Redo'}: ${r.applied} command(s)${label ? ` (${label})` : ''}`);
        return { via: 'server', applied: r.applied, label };
      } finally {
        release();
      }
    }
    const entry = dir === 'undo' ? await this.commands.undo() : await this.commands.redo();
    this.emit();
    return entry ? { via: 'client', applied: 1, label: entry.message } : { via: 'none', applied: 0 };
  }
}

/**
 * `DocumentUndo` insists on an `UndoStack`, but the app's client fallback is the
 * `CommandService` history, so the stack it is handed never records anything.
 */
const NO_CLIENT_STACK = {
  apply: () => undefined,
  undo: () => undefined,
  redo: () => undefined,
  get canUndo() {
    return false;
  },
  get canRedo() {
    return false;
  },
  get history() {
    return [];
  },
  clear: () => undefined,
} as unknown as ConstructorParameters<typeof DocumentUndo>[0];
