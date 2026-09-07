/** ItemStore: diffs, indexes, undo inverse, and DocumentSync's optimistic/canonical pipeline. */
import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { BoardLayer, DocumentSpecifierSchema, DocumentType, PadSchema } from "@fp-pcb/proto";
import { Pad, Track, type Item } from "../src/model/items";
import type { DocumentChange } from "../src/model/document";
import { DocumentSync, MemoryItemStore, UndoStack, inversePatch, toStoredItem, type StoreDiff } from "../src/store";
import { mm } from "../src/units";

const DOC = create(DocumentSpecifierSchema, {
  type: DocumentType.DOCTYPE_PCB,
  identifier: { case: "boardFilename", value: "x.kicad_pcb" },
});

function track(id: string, layer = BoardLayer.BL_F_Cu, net = "GND"): Track {
  const t = new Track();
  t.id = id;
  t.layerId = layer;
  t.width = mm(0.2);
  t.setNet(net, 1);
  return t;
}

describe("MemoryItemStore", () => {
  test("apply() indexes by type/layer/net, bumps revision, and emits a diff", () => {
    const s = new MemoryItemStore("board", DOC);
    const diffs: StoreDiff[] = [];
    s.subscribe((d) => diffs.push(d));
    const t1 = track("t1");
    const t2 = track("t2", BoardLayer.BL_B_Cu, "VCC");
    const pad = new Pad(create(PadSchema, { id: { value: "p1" }, net: { name: "GND" }, padStack: { layers: [BoardLayer.BL_F_Cu] } }));
    s.applyItems({ added: [t1, t2, pad] });
    expect(s.revision).toBe(1);
    expect(s.size).toBe(3);
    expect([...s.byType("KOT_PCB_TRACE")].map((i) => i.id).sort()).toEqual(["t1", "t2"]);
    expect([...s.byLayer("BL_F_Cu")].map((i) => i.id).sort()).toEqual(["p1", "t1"]);
    expect([...s.byNet("GND")].map((i) => i.id).sort()).toEqual(["p1", "t1"]);
    expect(s.get("t2")).toMatchObject({ id: "t2", type: "KOT_PCB_TRACE", layer: "BL_B_Cu", net: "VCC" });
    expect(diffs[0]!.added.length).toBe(3);
    expect(diffs[0]!.revision).toBe(1);
  });

  test("updates re-index and removals clean up; no-op patches do not bump the revision", () => {
    const s = new MemoryItemStore("board", DOC);
    s.applyItems({ added: [track("t1")] });
    const moved = track("t1", BoardLayer.BL_B_Cu, "VCC");
    const d = s.applyItems({ updated: [moved] })!;
    expect(d.updated.map((i) => i.id)).toEqual(["t1"]);
    expect([...s.byLayer("BL_F_Cu")]).toEqual([]);
    expect([...s.byNet("VCC")].map((i) => i.id)).toEqual(["t1"]);
    expect(s.layers()).toEqual(["BL_B_Cu"]);
    expect(s.apply({ removed: ["nope"] })).toBeUndefined();
    expect(s.revision).toBe(2);
    const r = s.applyItems({ removed: ["t1"] })!;
    expect(r.removed).toEqual(["t1"]);
    expect(s.size).toBe(0);
    expect(s.nets()).toEqual([]);
  });

  test("added-but-existing is reported as updated; updated-but-missing as added", () => {
    const s = new MemoryItemStore("board", DOC);
    s.applyItems({ added: [track("t1")] });
    const d = s.applyItems({ added: [track("t1")], updated: [track("t2")] })!;
    expect(d.updated.map((i) => i.id)).toEqual(["t1"]);
    expect(d.added.map((i) => i.id)).toEqual(["t2"]);
  });

  test("replaceAll() diffs against the current content", () => {
    const s = new MemoryItemStore("board", DOC);
    const t1 = track("t1");
    s.applyItems({ added: [t1, track("t2")] });
    const d = s.replaceAll([toStoredItem(t1), toStoredItem(track("t3"))])!;
    expect(d.added.map((i) => i.id)).toEqual(["t3"]);
    expect(d.updated).toEqual([]);
    expect(d.removed).toEqual(["t2"]);
    const d2 = s.replaceAll([toStoredItem(track("t1")), toStoredItem(track("t3"))])!;
    expect(d2.updated.map((i) => i.id)).toEqual(["t1", "t3"]); // new proto objects -> updated
  });
});

describe("undo helpers", () => {
  test("inversePatch captures previous versions before apply", () => {
    const s = new MemoryItemStore("board", DOC);
    const t1 = track("t1");
    s.applyItems({ added: [t1, track("t2")] });
    const patch = { added: [toStoredItem(track("t3"))], updated: [toStoredItem(track("t1", BoardLayer.BL_B_Cu))], removed: ["t2"] };
    const inv = inversePatch(s, patch);
    expect(inv.removed).toEqual(["t3"]);
    expect(inv.updated!.map((i) => i.id)).toEqual(["t1"]);
    expect(inv.updated![0]!.layer).toBe("BL_F_Cu");
    expect(inv.added!.map((i) => i.id)).toEqual(["t2"]);
    s.apply(patch);
    expect(s.get("t1")!.layer).toBe("BL_B_Cu");
    s.apply(inv);
    expect(s.get("t1")!.layer).toBe("BL_F_Cu");
    expect(s.has("t2")).toBe(true);
    expect(s.has("t3")).toBe(false);
  });

  test("UndoStack undo/redo round trip", () => {
    const s = new MemoryItemStore("board", DOC);
    const undo = new UndoStack(s);
    undo.apply("add", { added: [toStoredItem(track("t1"))] });
    undo.apply("move", { updated: [toStoredItem(track("t1", BoardLayer.BL_B_Cu))] });
    expect(undo.history.map((h) => h.label)).toEqual(["add", "move"]);
    expect(undo.undo()!.label).toBe("move");
    expect(s.get("t1")!.layer).toBe("BL_F_Cu");
    expect(undo.undo()!.label).toBe("add");
    expect(s.size).toBe(0);
    expect(undo.canUndo).toBe(false);
    expect(undo.redo()!.label).toBe("add");
    expect(undo.redo()!.label).toBe("move");
    expect(s.get("t1")!.layer).toBe("BL_B_Cu");
    expect(undo.canRedo).toBe(false);
  });
});

describe("DocumentSync", () => {
  function source(items: Item[]) {
    const listeners = new Set<(c: DocumentChange) => void>();
    return {
      kind: "board" as const,
      specifier: DOC,
      loads: 0,
      getAllItems: async function (this: { loads: number }) {
        this.loads++;
        return items;
      },
      onChange: (cb: (c: DocumentChange) => void) => (listeners.add(cb), () => listeners.delete(cb)),
      emit: (c: DocumentChange) => listeners.forEach((cb) => cb(c)),
    };
  }

  test("load() fills the store; optimistic then canonical applies; failure rolls back", async () => {
    const t1 = track("t1");
    const src = source([t1, track("t2")]);
    const sync = new DocumentSync(src);
    const diffs: StoreDiff[] = [];
    sync.store.subscribe((d) => diffs.push(d));
    await sync.load();
    expect(sync.store.size).toBe(2);
    expect(src.loads).toBe(1);

    // optimistic update: client-side wrapper goes in immediately
    const local = track("t1", BoardLayer.BL_B_Cu);
    const scope = {};
    src.emit({ kind: "update", phase: "optimistic", items: [local], ids: ["t1"], scope, commitId: "c1" });
    expect(sync.store.get("t1")!.layer).toBe("BL_B_Cu");
    // canonical: server version replaces it
    const canon = track("t1", BoardLayer.BL_In1_Cu);
    src.emit({ kind: "update", phase: "applied", items: [canon], ids: ["t1"], scope, commitId: "c1" });
    expect(sync.store.get("t1")!.layer).toBe("BL_In1_Cu");
    expect(sync.store.get("t1")!.proto).toBe(canon.proto);

    // failure: inverse of the optimistic patch restores the previous version
    const bad = track("t2", BoardLayer.BL_B_Cu);
    src.emit({ kind: "update", phase: "optimistic", items: [bad], ids: ["t2"], scope, commitId: "c2" });
    expect(sync.store.get("t2")!.layer).toBe("BL_B_Cu");
    src.emit({ kind: "update", phase: "failed", items: [bad], ids: ["t2"], scope, commitId: "c2" });
    expect(sync.store.get("t2")!.layer).toBe("BL_F_Cu");

    // create + delete
    src.emit({ kind: "create", phase: "optimistic", items: [track("t3")], ids: ["t3"], scope, commitId: "c3" });
    expect(sync.store.has("t3")).toBe(true);
    src.emit({ kind: "delete", phase: "optimistic", items: [], ids: ["t3"], scope, commitId: "c4" });
    expect(sync.store.has("t3")).toBe(false);
    src.emit({ kind: "delete", phase: "failed", items: [], ids: ["t3"], scope, commitId: "c4" });
    expect(sync.store.has("t3")).toBe(true);
    expect(diffs.every((d, i) => d.revision === i + 1)).toBe(true);
  });

  test("syncIds() re-reads the named items via getItemsById, drops deleted/missing ones, falls back to a full reload", async () => {
    const server = new Map<string, Item>([
      ["t1", track("t1")],
      ["t2", track("t2")],
    ]);
    const src = {
      ...source([...server.values()]),
      byIdCalls: [] as string[][],
      getItemsById: async (ids: readonly string[]) => (
        src.byIdCalls.push([...ids]),
        ids.map((id) => server.get(id)).filter((i): i is Item => !!i)
      ),
    };
    const sync = new DocumentSync(src);
    // before load: a full load
    await sync.syncIds({ updated: ["t1"] });
    expect(src.loads).toBe(1);
    expect(src.byIdCalls).toEqual([]);

    // another client moved t1 to B.Cu, created t3, deleted t2
    server.set("t1", track("t1", BoardLayer.BL_B_Cu));
    server.set("t3", track("t3"));
    server.delete("t2");
    const diffs: StoreDiff[] = [];
    sync.store.subscribe((d) => diffs.push(d));
    await sync.syncIds({ created: ["t3"], updated: ["t1"], deleted: ["t2"] });
    expect(src.byIdCalls).toEqual([["t3", "t1"]]);
    expect(src.loads).toBe(1);
    expect(sync.store.get("t1")!.layer).toBe("BL_B_Cu");
    expect(sync.store.has("t3")).toBe(true);
    expect(sync.store.has("t2")).toBe(false);
    expect(diffs.length).toBe(1);
    expect(diffs[0]!.added.map((i) => i.id)).toEqual(["t3"]);
    expect(diffs[0]!.updated.map((i) => i.id)).toEqual(["t1"]);
    expect(diffs[0]!.removed).toEqual(["t2"]);

    // KiCad records a footprint UpdateItems as remove + add of the same KIID: that is an update
    server.set("t1", track("t1", BoardLayer.BL_In1_Cu));
    await sync.syncIds({ created: ["t1"], deleted: ["t1"] });
    expect(sync.store.get("t1")!.layer).toBe("BL_In1_Cu");
    expect(src.byIdCalls.at(-1)).toEqual(["t1"]);

    // an id KiCad no longer returns is removed; a "changed" item without ids is a full reload
    server.delete("t3");
    await sync.syncIds({ updated: ["t3"] });
    expect(sync.store.has("t3")).toBe(false);
    await sync.syncIds({});
    expect(src.loads).toBe(2);
  });

  test("syncSince() merges deltas / replaces on full answers; refresh() prefers it only when the server supports it", async () => {
    const server = new Map<string, Item>([
      ["t1", track("t1")],
      ["t2", track("t2")],
    ]);
    let revision = 10n;
    let supported = true;
    let full = false;
    const deleted: string[] = [];
    const src = {
      ...source([...server.values()]),
      sinceCalls: [] as (bigint | undefined)[],
      supportsIncrementalSync: async () => supported,
      getItemsSince: async (since: bigint | undefined) => {
        src.sinceCalls.push(since);
        if (since === undefined || full) return { items: [...server.values()], deletedIds: [], revision, full: true };
        if (since >= revision) return { items: [], deletedIds: [], revision, full: false };
        return { items: [...server.values()].filter((i) => i.id === "t1"), deletedIds: [...deleted], revision, full: false };
      },
    };
    const sync = new DocumentSync(src);
    await sync.syncSince(); // before load: a full load through getItemsSince(undefined)
    expect(src.sinceCalls).toEqual([undefined]);
    expect(src.loads).toBe(0);
    expect(sync.revision).toBe(10n);
    expect(sync.store.size).toBe(2);

    // another client moved t1 and deleted t2
    server.set("t1", track("t1", BoardLayer.BL_B_Cu));
    server.delete("t2");
    deleted.push("t2");
    revision = 11n;
    const diffs: StoreDiff[] = [];
    sync.store.subscribe((d) => diffs.push(d));
    await sync.refresh();
    expect(src.sinceCalls).toEqual([undefined, 10n]);
    expect(src.loads).toBe(0);
    expect(sync.revision).toBe(11n);
    expect(diffs.length).toBe(1);
    expect(diffs[0]!.updated.map((i) => i.id)).toEqual(["t1"]);
    expect(diffs[0]!.removed).toEqual(["t2"]);
    expect(sync.store.get("t1")!.layer).toBe("BL_B_Cu");

    // a full answer (change log exhausted) replaces: a stale local item goes away
    sync.store.applyItems({ added: [track("stale")] });
    full = true;
    revision = 12n;
    await sync.syncSince();
    expect(sync.store.has("stale")).toBe(false);
    expect(sync.revision).toBe(12n);

    // without server support, refresh() is a full load (getItemsSince(undefined))
    const src2 = { ...source([track("a")]), getItemsSince: src.getItemsSince, supportsIncrementalSync: async () => false };
    const sync2 = new DocumentSync(src2);
    await sync2.load();
    src.sinceCalls.length = 0;
    await sync2.refresh();
    expect(src.sinceCalls).toEqual([undefined]);
    expect(await sync2.supportsIncrementalSync()).toBe(false);
  });

  test("changes before load() are ignored; dispose() unsubscribes", async () => {
    const src = source([track("t1")]);
    const sync = new DocumentSync(src);
    src.emit({ kind: "create", phase: "applied", items: [track("t9")], ids: ["t9"], scope: {}, commitId: "" });
    expect(sync.store.size).toBe(0);
    await sync.load();
    sync.dispose();
    src.emit({ kind: "create", phase: "applied", items: [track("t9")], ids: ["t9"], scope: {}, commitId: "" });
    expect(sync.store.size).toBe(1);
  });
});
