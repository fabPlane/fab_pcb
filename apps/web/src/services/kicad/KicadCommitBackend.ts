// CommitBackend over the client's commit pipeline: `begin` = BeginCommit, `apply` = the
// transaction's create/update/delete ops as CreateItems / UpdateItems / DeleteItems on that
// commit (KiCad's canonical items come back and replace the optimistic copies through the
// client's DocumentSync), `end` = EndCommit(CMA_COMMIT | CMA_DROP). A rejected item drops
// the commit; CommandService then rolls the store back to the pre-states.

import { create, type Message } from '@bufbuild/protobuf';
import { kiapiRegistry } from '@fp-pcb/proto';
import { Item, toStoredItem, wrapMessage, type Commit } from '@fp-pcb/client';
import type { ItemStore, StoredItem } from '@/contracts';
import type { CommitBackend } from '../CommandService';
import type { ItemOp } from '../types';
import type { KicadDocumentService } from './KicadDocumentService';

interface OpenCommit {
  commit: Commit;
  message: string;
  release: () => void;
}

/**
 * Turns a store item (a protobuf-es message, or a spread copy of one after a patch) into the
 * client's wrapper. Copies produced by the properties panel / move tool keep `$typeName` at
 * the top level but may contain plain nested objects (`{ value: kiid }`, `{ xNm: 7 }`), which
 * `create()` re-types; already-typed branches are shared, not cloned.
 */
export function toItem(stored: StoredItem): Item {
  const proto = stored.proto as Message;
  if (stored.item instanceof Item && stored.item.proto === proto) return stored.item;
  const typeName = proto?.$typeName;
  const desc = typeof typeName === 'string' ? kiapiRegistry.getMessage(typeName) : undefined;
  if (!desc) throw new Error(`cannot commit ${stored.type} ${stored.id}: proto has no known $typeName`);
  const { $typeName: _t, ...rest } = proto as Message & Record<string, unknown>;
  const msg = create(desc, rest as never);
  return wrapMessage(msg, desc);
}

export class KicadCommitBackend implements CommitBackend {
  private open = new Map<ItemStore, OpenCommit>();
  /** KiCad allows one open commit per client, so transactions are serialised. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly docs: KicadDocumentService,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
  ) {}

  async begin(store: ItemStore, message: string): Promise<void> {
    const target = this.docs.targetFor(store);
    if (!target) throw new Error('cannot commit: the store does not belong to an open KiCad document');
    const previous = this.chain;
    let unlock!: () => void;
    this.chain = new Promise<void>((r) => (unlock = r));
    await previous;
    const activity = this.docs.beginActivity();
    const release = () => {
      activity();
      unlock();
    };
    try {
      const commit = await target.beginCommit();
      this.open.set(store, { commit, message, release });
    } catch (e) {
      release();
      throw e;
    }
  }

  async apply(store: ItemStore, ops: ItemOp[]): Promise<ItemOp[]> {
    const oc = this.open.get(store);
    if (!oc) throw new Error('apply() without begin()');
    const out: ItemOp[] = [];
    // Consecutive ops of one kind go out as one request (the client merges same-tick calls).
    let i = 0;
    while (i < ops.length) {
      const kind = ops[i]!.kind;
      const batch: ItemOp[] = [];
      while (i < ops.length && ops[i]!.kind === kind) batch.push(ops[i++]!);
      if (kind === 'delete') {
        await oc.commit.delete(batch.map((o) => o.item.id));
        out.push(...batch);
        continue;
      }
      const wrappers = batch.map((o) => toItem(o.item));
      const canonical = kind === 'create' ? await oc.commit.create(wrappers) : await oc.commit.update(wrappers);
      canonical.forEach((item, j) => {
        const optimistic = batch[j]!.item;
        out.push({ kind, item: { ...toStoredItem(item), bbox: optimistic.bbox } });
      });
    }
    return out;
  }

  async end(store: ItemStore, action: 'commit' | 'drop'): Promise<void> {
    const oc = this.open.get(store);
    if (!oc) {
      // `drop` for a transaction that never began (empty forward set): nothing to end.
      return;
    }
    this.open.delete(store);
    try {
      if (action === 'commit') {
        await oc.commit.push(oc.message);
        this.log(`EndCommit(CMA_COMMIT) "${oc.message}"`);
      } else {
        await oc.commit.drop();
        this.log(`EndCommit(CMA_DROP) "${oc.message}"`, 'warn');
      }
    } finally {
      oc.release();
      const target = this.docs.targetFor(store);
      if (target) void this.docs.afterCommit(target.kind);
    }
  }
}
