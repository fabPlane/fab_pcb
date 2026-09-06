/**
 * `Commit` — a KiCad commit in progress (`BeginCommit` ... `EndCommit`). Create/update/delete
 * calls made on it are batched: calls issued in the same tick and aimed at the same container are
 * merged into one `CreateItems` / `UpdateItems` / `DeleteItems` request, in order. Results are the
 * canonical items KiCad echoes back (with server-assigned ids and normalised fields).
 */
import type { Message } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";
import { CommitAction, ItemDeletionStatus, ItemRequestStatus, ItemStatusCode, KiCadObjectType, type ItemStatus } from "@kicad-web/proto";
import * as cmd from "../commands";
import { CommitDroppedError, KiCadItemError, type ItemFailure } from "../errors";
import type { Document, ItemScope, UndoRedoResult } from "./document";
import { Item, toAnyItem, wrapAny } from "./items";

export type ItemInput = Item | Message | Any;

export interface DeleteResult {
  id: string;
  status: ItemDeletionStatus;
  ok: boolean;
}

export interface CommitResult<T> {
  value: T;
  commitId: string;
  /** Canonical items KiCad returned for creates, in request order. */
  created: Item[];
  updated: Item[];
  /** KIIDs KiCad confirmed deleted. */
  deleted: string[];
}

export interface CommitOptions {
  /** Throw `KiCadItemError` when KiCad rejects any item (default true). When false, rejected items are skipped. */
  strict?: boolean;
}

type OpKind = "create" | "update" | "delete";

interface Op {
  kind: OpKind;
  scope: ItemScope;
  key: string;
  /** Wrappers (or generic wrappers) for the request items; used for optimistic events and ids. */
  wrappers: Item[];
  anys: Any[];
  ids: string[];
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/** Item types that must be addressed through their parent container on a board. */
const NEEDS_CONTAINER = new Set<KiCadObjectType>([
  KiCadObjectType.KOT_PCB_PAD,
  KiCadObjectType.KOT_PCB_FIELD,
  KiCadObjectType.KOT_PCB_TABLECELL,
]);

function scopeKey(scope: ItemScope): string {
  const sheet = scope.sheetPath ? scope.sheetPath.path.map((k) => k.value).join("/") : "";
  return `${scope.container ?? ""}|${sheet}`;
}

function toWrapper(x: ItemInput): Item {
  if (x instanceof Item) return x;
  const any = toAnyItem(x);
  const w = wrapAny(any);
  if (!w) throw new Error(`cannot wrap item of type ${any.typeUrl}`);
  return w;
}

export class Commit {
  readonly created: Item[] = [];
  readonly updated: Item[] = [];
  readonly deleted: string[] = [];
  private readonly queue: Op[] = [];
  private scheduled = false;
  private flushing: Promise<void> | null = null;
  private ended = false;
  private readonly strict: boolean;

  constructor(
    readonly doc: Document,
    /** KiCad's id for the commit; empty for one-shot operations outside `BeginCommit`. */
    readonly id: string,
    readonly scope: ItemScope,
    opts: CommitOptions = {},
  ) {
    this.strict = opts.strict ?? true;
  }

  get isOpen(): boolean {
    return !this.ended;
  }

  /** `CreateItems`. Items with an empty id get a fresh UUID so the store can track them optimistically. */
  create(items: readonly ItemInput[], scope?: ItemScope): Promise<Item[]> {
    const wrappers = items.map(toWrapper);
    for (const w of wrappers)
      if (!w.id && w.schema.fields.some((f) => f.name === "id" && f.fieldKind === "message")) w.id = crypto.randomUUID();
    return this.enqueue("create", wrappers, scope) as Promise<Item[]>;
  }

  /** `UpdateItems`; the returned wrappers are KiCad's canonical versions. */
  update(items: readonly ItemInput[], scope?: ItemScope): Promise<Item[]> {
    return this.enqueue("update", items.map(toWrapper), scope) as Promise<Item[]>;
  }

  /** `DeleteItems` by wrapper or KIID. */
  delete(items: readonly (Item | string)[], scope?: ItemScope): Promise<DeleteResult[]> {
    const ids = items.map((i) => (typeof i === "string" ? i : i.id));
    return this.enqueue(
      "delete",
      items.filter((i): i is Item => i instanceof Item),
      scope,
      ids,
    ) as Promise<DeleteResult[]>;
  }

  /** Resolves once every queued request has been sent and answered. */
  async drain(): Promise<void> {
    while (this.queue.length || this.flushing) {
      if (this.flushing) await this.flushing;
      else await new Promise<void>((r) => queueMicrotask(r));
    }
  }

  /** `EndCommit(CMA_COMMIT, message)` after draining the queue. */
  async push(message = ""): Promise<void> {
    await this.drain();
    if (this.ended) return;
    this.ended = true;
    if (!this.id) return;
    await cmd.endCommit(this.doc.client, {
      id: { value: this.id },
      action: CommitAction.CMA_COMMIT,
      message,
      header: this.doc.header(this.scope),
    });
  }

  /** `EndCommit(CMA_DROP)`: reverts everything done in this commit. Never throws. */
  async drop(): Promise<void> {
    try {
      await this.drain();
    } catch {
      /* the failed op is what we are dropping */
    }
    if (this.ended) return;
    this.ended = true;
    if (!this.id) return;
    try {
      await cmd.endCommit(this.doc.client, { id: { value: this.id }, action: CommitAction.CMA_DROP, header: this.doc.header(this.scope) });
    } catch {
      /* best effort */
    }
  }

  /**
   * Undoes this commit after it was pushed, through KiCad's own undo stack (`Undo`, KiCad >=
   * 11.0) rather than by replaying inverse patches client-side: the server holds the authoritative
   * history, so its undo also restores state the client never mirrored (zone fills, connectivity,
   * netlist changes). Only valid while this commit is still the newest entry on the document's
   * undo stack — anything pushed after it would be undone instead, so this throws when
   * `GetUndoStack`'s last undo entry carries a different commit id. Throws `KiCadApiError` when
   * the server predates `Undo`; `drop()` is the pre-push equivalent.
   */
  async undo(): Promise<UndoRedoResult> {
    if (!this.ended) throw new Error(`commit ${this.id || "(one-shot)"} has not been pushed yet — use drop()`);
    if (this.id) {
      const top = (await this.doc.undoStack()).undo.at(-1);
      const topId = top?.commitId?.value ?? "";
      if (topId && topId !== this.id) {
        throw new Error(`commit ${this.id} is no longer the top of the undo stack (${top?.description ?? topId})`);
      }
    }
    return this.doc.undo(1);
  }

  /** Runs `fn`, pushing on success and dropping on throw. */
  async run<T>(message: string, fn: (tx: Commit) => Promise<T> | T): Promise<CommitResult<T>> {
    let value: T;
    try {
      value = await fn(this);
      await this.drain();
    } catch (e) {
      await this.drop();
      throw new CommitDroppedError(this.id, e);
    }
    await this.push(message);
    return { value, commitId: this.id, created: this.created, updated: this.updated, deleted: this.deleted };
  }

  // --- internals ---------------------------------------------------------------------------------

  private enqueue(kind: OpKind, wrappers: Item[], scope: ItemScope | undefined, ids?: string[]): Promise<unknown> {
    if (this.ended) return Promise.reject(new Error(`commit ${this.id || "(one-shot)"} has already ended`));
    const groups = new Map<string, Op>();
    const promises: Promise<unknown>[] = [];
    const list = wrappers.length ? wrappers : (ids ?? []).map(() => undefined);
    list.forEach((w, i) => {
      const s = this.scopeFor(w, scope);
      const key = `${kind}|${scopeKey(s)}`;
      let op = groups.get(key);
      if (!op) {
        let resolve!: (v: unknown) => void;
        let reject!: (e: unknown) => void;
        promises.push(new Promise((res, rej) => ((resolve = res), (reject = rej))));
        op = { kind, scope: s, key, wrappers: [], anys: [], ids: [], resolve, reject };
        groups.set(key, op);
        this.queue.push(op);
      }
      if (w) {
        op.wrappers.push(w);
        if (kind !== "delete") op.anys.push(w.toAny());
      }
      op.ids.push(ids ? ids[i]! : w!.id);
    });
    this.scheduleFlush();
    if (promises.length === 1) return promises[0]!;
    return Promise.all(promises).then((parts) => parts.flat());
  }

  private scopeFor(item: Item | undefined, scope: ItemScope | undefined): ItemScope {
    const s: ItemScope = { ...this.scope, ...scope };
    if (!s.container && item && NEEDS_CONTAINER.has(item.type) && item.parent) s.container = item.parent;
    return s;
  }

  private scheduleFlush(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.flushing) return; // the running flush loop will pick the new ops up
      this.flushing = this.flush().finally(() => (this.flushing = null));
    });
  }

  private async flush(): Promise<void> {
    while (this.queue.length) {
      // Merge consecutive ops with the same kind + scope into one request.
      const first = this.queue.shift()!;
      const batch = [first];
      while (this.queue.length && this.queue[0]!.key === first.key) batch.push(this.queue.shift()!);
      const merged: Op = {
        ...first,
        wrappers: batch.flatMap((b) => b.wrappers),
        anys: batch.flatMap((b) => b.anys),
        ids: batch.flatMap((b) => b.ids),
        resolve: () => {},
        reject: () => {},
      };
      try {
        const results = await this.execute(merged);
        // Split results back per original op, in order.
        let offset = 0;
        for (const b of batch) {
          const n = b.ids.length;
          b.resolve(results.slice(offset, offset + n));
          offset += n;
        }
      } catch (e) {
        for (const b of batch) b.reject(e);
      }
    }
  }

  private async execute(op: Op): Promise<unknown[]> {
    const doc = this.doc;
    const emit = (phase: "optimistic" | "applied" | "failed", items: Item[], ids: string[]) =>
      doc.emitChange({ kind: op.kind, phase, items, ids, scope: op.scope, commitId: this.id });
    emit("optimistic", op.wrappers, op.ids);
    try {
      if (op.kind === "delete") {
        const res = await cmd.deleteItems(doc.client, { header: doc.header(op.scope), itemIds: op.ids.map((value) => ({ value })) });
        this.checkStatus(res.status, "DeleteItems");
        const byId = new Map(res.deletedItems.map((r) => [r.id?.value ?? "", r.status]));
        const results: DeleteResult[] = op.ids.map((id) => {
          const status = byId.get(id) ?? ItemDeletionStatus.IDS_UNKNOWN;
          return { id, status, ok: status === ItemDeletionStatus.IDS_OK };
        });
        const failures: ItemFailure[] = results
          .filter((r) => !r.ok)
          .map((r, i) => ({ id: r.id, index: i, code: r.status, codeName: ItemDeletionStatus[r.status] ?? String(r.status), message: "" }));
        if (failures.length && this.strict) throw new KiCadItemError("DeleteItems", failures);
        const deletedIds = results.filter((r) => r.ok).map((r) => r.id);
        this.deleted.push(...deletedIds);
        emit("applied", [], deletedIds);
        return results;
      }
      const header = doc.header(op.scope);
      const command = op.kind === "create" ? "CreateItems" : "UpdateItems";
      const rows =
        op.kind === "create"
          ? await cmd.createItems(doc.client, { header, items: op.anys }).then((r) => (this.checkStatus(r.status, command), r.createdItems))
          : await cmd
              .updateItems(doc.client, { header, items: op.anys })
              .then((r) => (this.checkStatus(r.status, command), r.updatedItems));
      const canonical: (Item | undefined)[] = [];
      const failures: ItemFailure[] = [];
      rows.forEach((row: { status?: ItemStatus; item?: Any }, i) => {
        const code = row.status?.code ?? ItemStatusCode.ISC_UNKNOWN;
        if (code === ItemStatusCode.ISC_OK && row.item) {
          canonical.push(wrapAny(row.item) ?? op.wrappers[i]);
        } else {
          canonical.push(undefined);
          failures.push({
            id: op.ids[i] ?? "",
            index: i,
            code,
            codeName: ItemStatusCode[code] ?? String(code),
            message: row.status?.errorMessage ?? "",
          });
        }
      });
      if (failures.length && this.strict) throw new KiCadItemError(command, failures);
      const ok = canonical.filter((c): c is Item => c !== undefined);
      (op.kind === "create" ? this.created : this.updated).push(...ok);
      emit(
        "applied",
        ok,
        ok.map((c) => c.id),
      );
      return canonical;
    } catch (e) {
      emit("failed", op.wrappers, op.ids);
      throw e;
    }
  }

  private checkStatus(status: ItemRequestStatus, command: string): void {
    if (status !== ItemRequestStatus.IRS_OK && status !== ItemRequestStatus.IRS_UNKNOWN) {
      throw new KiCadItemError(command, [], status);
    }
  }
}
