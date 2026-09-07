/** Commit lifecycle against the fake transport: BeginCommit → batched Create/Update/Delete → EndCommit. */
import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { anyUnpack } from "@bufbuild/protobuf/wkt";
import {
  ApiStatusCode,
  BeginCommitResponseSchema,
  BeginCommitSchema,
  BoardLayer,
  CommitAction,
  CreateItemsResponseSchema,
  CreateItemsSchema,
  DeleteItemsResponseSchema,
  DeleteItemsSchema,
  DocumentSpecifierSchema,
  DocumentType,
  EndCommitResponseSchema,
  EndCommitSchema,
  GetItemsResponseSchema,
  GetItemsSchema,
  ItemDeletionStatus,
  ItemRequestStatus,
  ItemStatusCode,
  KiCadObjectType,
  PadSchema,
  TrackSchema,
  UpdateItemsResponseSchema,
  UpdateItemsSchema,
  kiapiRegistry,
  packAny,
  type Track as TrackProto,
} from "@fp-pcb/proto";
import { KiCadClient } from "../src/client";
import { CommitDroppedError, KiCadItemError } from "../src/errors";
import { Board, KiCad, Pad, Track, wrapAny, type Item } from "../src/model";
import { mm } from "../src/units";
import { FakeTransport, fail, reply } from "./fake-transport";

const DOC = create(DocumentSpecifierSchema, { type: DocumentType.DOCTYPE_PCB, identifier: { case: "boardFilename", value: "x.kicad_pcb" } });

/** A fake board server: a map of items, commit bookkeeping, and echo-style create/update/delete. */
function boardServer() {
  const t = new FakeTransport();
  const items = new Map<string, Item>();
  const log: string[] = [];
  let commitId = 0;
  t.on(BeginCommitSchema, () => {
    log.push("begin");
    return reply(BeginCommitResponseSchema, { id: { value: `commit-${++commitId}` } });
  });
  t.on(EndCommitSchema, (req) => {
    log.push(`end:${req.action === CommitAction.CMA_COMMIT ? "commit" : "drop"}:${req.id?.value}:${req.message}`);
    return reply(EndCommitResponseSchema, {});
  });
  t.on(GetItemsSchema, (req) => {
    const wanted = new Set(req.types);
    return reply(GetItemsResponseSchema, {
      status: ItemRequestStatus.IRS_OK,
      items: [...items.values()].filter((i) => wanted.has(i.type)).map((i) => i.toAny()),
    });
  });
  t.on(CreateItemsSchema, (req) => {
    log.push(`create:${req.items.length}:${req.header?.container?.value ?? ""}`);
    return reply(CreateItemsResponseSchema, {
      status: ItemRequestStatus.IRS_OK,
      createdItems: req.items.map((a) => {
        const w = wrapAny(a)!;
        if (items.has(w.id)) return { status: { code: ItemStatusCode.ISC_EXISTING, errorMessage: "exists" }, item: a };
        // Canonicalise: the server rounds widths to 10 nm.
        if (w instanceof Track) w.width = Math.round(w.width / 10) * 10;
        items.set(w.id, w);
        return { status: { code: ItemStatusCode.ISC_OK }, item: w.toAny() };
      }),
    });
  });
  t.on(UpdateItemsSchema, (req) => {
    log.push(`update:${req.items.length}:${req.header?.container?.value ?? ""}`);
    return reply(UpdateItemsResponseSchema, {
      status: ItemRequestStatus.IRS_OK,
      updatedItems: req.items.map((a) => {
        const w = wrapAny(a)!;
        if (!items.has(w.id)) return { status: { code: ItemStatusCode.ISC_NONEXISTENT, errorMessage: "missing" }, item: a };
        items.set(w.id, w);
        return { status: { code: ItemStatusCode.ISC_OK }, item: w.toAny() };
      }),
    });
  });
  t.on(DeleteItemsSchema, (req) => {
    log.push(`delete:${req.itemIds.length}`);
    return reply(DeleteItemsResponseSchema, {
      status: ItemRequestStatus.IRS_OK,
      deletedItems: [...req.itemIds]
        .sort((a, b) => a.value.localeCompare(b.value))
        .map((k) => ({ id: k, status: items.delete(k.value) ? ItemDeletionStatus.IDS_OK : ItemDeletionStatus.IDS_NONEXISTENT })),
    });
  });
  return { t, items, log };
}

function track(id: string, width = mm(0.25)): Track {
  const tr = new Track();
  tr.id = id;
  tr.start = { x: 0, y: 0 };
  tr.end = { x: mm(10), y: 0 };
  tr.width = width;
  tr.layerId = BoardLayer.BL_F_Cu;
  tr.setNet("GND", 1);
  return tr;
}

async function board(t: FakeTransport): Promise<Board> {
  const kicad = new KiCad(await KiCadClient.connect(t, { clientName: "commit-test" }));
  return kicad.boardFrom(DOC);
}

describe("Commit lifecycle", () => {
  test("commit(): BeginCommit, batched creates, EndCommit(CMA_COMMIT, message); returns canonical items", async () => {
    const { t, items, log } = boardServer();
    const b = await board(t);
    const res = await b.commit("Add tracks", async (tx) => {
      const p1 = tx.create([track("t1", 123_456)]);
      const p2 = tx.create([track("t2")]);
      const [c1] = await p1;
      const [c2] = await p2;
      return { c1, c2 };
    });
    expect(log).toEqual(["begin", "create:2:", "end:commit:commit-1:Add tracks"]);
    expect(res.commitId).toBe("commit-1");
    expect(res.created.map((i) => i.id)).toEqual(["t1", "t2"]);
    expect((res.value.c1 as Track).width).toBe(123_460); // canonical, not the client value
    expect(items.size).toBe(2);
  });

  test("throwing inside the callback drops the commit and wraps the error", async () => {
    const { t, log } = boardServer();
    const b = await board(t);
    const err = await b
      .commit("oops", async (tx) => {
        await tx.create([track("t1")]);
        throw new Error("boom");
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommitDroppedError);
    expect((err as CommitDroppedError).cause).toMatchObject({ message: "boom" });
    expect(log).toEqual(["begin", "create:1:", "end:drop:commit-1:"]);
  });

  test("rejected items throw KiCadItemError (strict) and drop; strict:false skips them", async () => {
    const { t, items, log } = boardServer();
    const b = await board(t);
    items.set("t1", track("t1"));
    const err = await b.commit("dup", (tx) => tx.create([track("t1"), track("t2")])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommitDroppedError);
    const cause = (err as CommitDroppedError).cause as KiCadItemError;
    expect(cause).toBeInstanceOf(KiCadItemError);
    expect(cause.failures).toEqual([{ id: "t1", index: 0, code: ItemStatusCode.ISC_EXISTING, codeName: "ISC_EXISTING", message: "exists" }]);
    expect(log.at(-1)).toBe("end:drop:commit-1:");

    const res = await b.commit("dup", (tx) => tx.create([track("t1"), track("t3")]), undefined, { strict: false });
    expect(res.value.map((i) => (i as Item | undefined)?.id)).toEqual([undefined, "t3"] as (string | undefined)[]);
    expect(res.created.map((i) => i.id)).toEqual(["t3"]);
  });

  test("updates, deletes and container inference for pads", async () => {
    const { t, items, log } = boardServer();
    const b = await board(t);
    items.set("t1", track("t1"));
    const pad = new Pad(create(PadSchema, { id: { value: "p1" }, parent: { value: "fp1" }, number: "1" }));
    items.set("p1", pad);
    const tr = (await b.getItems(KiCadObjectType.KOT_PCB_TRACE))[0] as Track;
    tr.width = mm(1);
    await b.commit("edit", async (tx) => {
      const u1 = tx.update([tr]);
      const u2 = tx.update([pad]); // needs container = parent footprint -> separate request
      const d = tx.delete(["t-missing"], undefined);
      await Promise.all([u1, u2]).then(() => undefined);
      const [res] = await d.catch(() => [{ id: "t-missing", ok: false }]);
      expect(res!.ok).toBe(false);
    }, undefined, { strict: false });
    expect(log).toEqual(["begin", "update:1:", "update:1:fp1", "delete:1", "end:commit:commit-1:edit"]);
    expect((items.get("t1") as Track).width).toBe(mm(1));
    const updateReqs = t.requestsOf(UpdateItemsSchema);
    expect(updateReqs[1]!.header?.container?.value).toBe("fp1");
  });

  test("one-shot updateItems outside a commit sends no Begin/EndCommit", async () => {
    const { t, items, log } = boardServer();
    const b = await board(t);
    items.set("t1", track("t1"));
    const tr = track("t1", mm(2));
    const [canon] = await b.updateItems([tr]);
    expect((canon as Track).width).toBe(mm(2));
    expect(log).toEqual(["update:1:"]);
  });

  test("beginCommit()/push() manual flow and change events", async () => {
    const { t, log } = boardServer();
    const b = await board(t);
    const events: string[] = [];
    b.onChange((c) => events.push(`${c.kind}:${c.phase}:${c.ids.join(",")}`));
    const tx = await b.beginCommit();
    const created = await tx.create([track("t1")]);
    expect(created[0]!.id).toBe("t1");
    await tx.delete(created);
    await tx.push("manual");
    expect(log).toEqual(["begin", "create:1:", "delete:1", "end:commit:commit-1:manual"]);
    expect(events).toEqual(["create:optimistic:t1", "create:applied:t1", "delete:optimistic:t1", "delete:applied:t1"]);
    await expect(tx.create([track("t2")])).rejects.toThrow(/already ended/);
  });

  test("created items without an id get a UUID before the request", async () => {
    const { t } = boardServer();
    const b = await board(t);
    const tr = new Track(create(TrackSchema, { width: { valueNm: 100n } }));
    const [c] = await b.createItems([tr]);
    expect(c!.id).toMatch(/^[0-9a-f-]{36}$/);
    const sent = t.requestsOf(CreateItemsSchema)[0]!.items[0]!;
    expect((anyUnpack(sent, kiapiRegistry) as TrackProto).id?.value).toBe(c!.id);
  });

  test("a transport-level failure inside the commit still drops it", async () => {
    const { t, log } = boardServer();
    t.on(UpdateItemsSchema, () => fail(ApiStatusCode.AS_BAD_REQUEST, "nope"));
    const b = await board(t);
    await expect(b.commit("x", (tx) => tx.update([track("t1")]))).rejects.toBeInstanceOf(CommitDroppedError);
    expect(log).toEqual(["begin", "end:drop:commit-1:"]);
    expect(packAny).toBeDefined();
  });
});
