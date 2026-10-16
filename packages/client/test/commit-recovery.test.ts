import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  ApiStatusCode,
  BeginCommitResponseSchema,
  BeginCommitSchema,
  CommitAction,
  DocumentSpecifierSchema,
  DocumentType,
  EndCommitResponseSchema,
  EndCommitSchema,
  UndoStackResponseSchema,
  GetUndoStackSchema,
  ItemRequestStatus,
  ItemStatusCode,
  UndoSchema,
  UndoRedoResponseSchema,
  UpdateItemsResponseSchema,
  UpdateItemsSchema,
} from "@fp-pcb/proto";
import { KiCadClient } from "../src/client";
import { CommitDroppedError, CommitRecoveryError } from "../src/errors";
import { KiCad, Track, wrapAny } from "../src/model";
import { FakeTransport, fail, reply } from "./fake-transport";

function server(mode: "pending" | "pushed" | "newer" | "no-undo") {
  const t = new FakeTransport();
  // One already-unsaved user edit exists before this transaction.
  let live = { moved: 10, unsaved: 42 },
    before = { ...live },
    active = false;
  let undoCalls = 0,
    drops = 0;
  t.on(BeginCommitSchema, () => {
    before = { ...live };
    active = true;
    return reply(BeginCommitResponseSchema, { id: { value: "our-edit" } });
  });
  t.on(UpdateItemsSchema, (req) => {
    live.moved = (wrapAny(req.items[0]!) as Track).width;
    return reply(UpdateItemsResponseSchema, {
      status: ItemRequestStatus.IRS_OK,
      updatedItems: req.items.map((item) => ({ status: { code: ItemStatusCode.ISC_OK }, item })),
    });
  });
  t.on(EndCommitSchema, (req) => {
    if (req.action === CommitAction.CMA_DROP) {
      drops++;
      if (!active) return fail(ApiStatusCode.AS_BAD_REQUEST, "no commit in progress");
      live = { ...before };
      active = false;
      return reply(EndCommitResponseSchema, {});
    }
    if (mode !== "pending") active = false;
    if (mode === "newer") live.unsaved = 99;
    return fail(ApiStatusCode.AS_BAD_REQUEST, "forced finalization failure");
  });
  t.on(GetUndoStackSchema, () =>
    mode === "no-undo"
      ? fail(ApiStatusCode.AS_UNIMPLEMENTED, "undo unavailable")
      : reply(UndoStackResponseSchema, { undo: [{ commitId: { value: mode === "newer" ? "someone-else" : "our-edit" } }] }),
  );
  t.on(UndoSchema, () => {
    undoCalls++;
    live = { ...before };
    return reply(UndoRedoResponseSchema, { applied: 1, undoCount: 0, redoCount: 1 });
  });
  const doc = async () =>
    new KiCad(await KiCadClient.connect(t, { clientName: "recovery-test" })).boardFrom(
      create(DocumentSpecifierSchema, {
        type: DocumentType.DOCTYPE_PCB,
        identifier: { case: "boardFilename", value: "board.kicad_pcb" },
      }),
    );
  return { t, doc, live: () => live, counts: () => ({ undoCalls, drops }) };
}

function edit() {
  const track = new Track();
  track.id = "moved";
  track.width = 25;
  return track;
}

describe("commit finalization containment", () => {
  for (const mode of ["pending", "pushed"] as const)
    for (const path of ["run", "push"] as const)
      test(`${mode} finalization failure via ${path}: restore live state including unsaved work`, async () => {
        const f = server(mode),
          doc = await f.doc();
        let error: unknown;
        if (path === "run") {
          try {
            await doc.commit("edit", (tx) => tx.update([edit()]));
          } catch (e) {
            error = e;
          }
        } else {
          const tx = await doc.beginCommit();
          await tx.update([edit()]);
          try {
            await tx.push("edit");
          } catch (e) {
            error = e;
          }
          await expect(tx.update([edit()])).rejects.toThrow("ended");
        }
        expect(error).toBeInstanceOf(CommitDroppedError);
        expect((error as CommitDroppedError).recovery).toBe(mode === "pending" ? "dropped" : "undone");
        expect((error as Error).message).toContain("Prior live state restored");
        expect((error as Error).message).toContain("forced finalization failure");
        expect(f.live()).toEqual({ moved: 10, unsaved: 42 });
        expect(f.counts()).toEqual({ drops: 1, undoCalls: mode === "pending" ? 0 : 1 });
      });

  test("a callback that throws with an item request still queued drains it before dropping", async () => {
    const f = server("pending"),
      doc = await f.doc();
    let queued: Promise<unknown> | undefined;
    const error = await doc
      .commit("edit", async (tx) => {
        queued = tx.update([edit()]);
        throw new Error("callback failed");
      })
      .catch((e: unknown) => e);
    await queued?.catch(() => undefined);
    expect(error).toBeInstanceOf(CommitDroppedError);
    expect((error as Error).message).toContain("callback failed");
    const order = f.t.calls.map((c) => c.typeName).filter((n) => /UpdateItems$|EndCommit$/.test(n));
    expect(order.map((n) => n.split(".").at(-1))).toEqual(["UpdateItems", "EndCommit"]);
    // The update ran inside the transaction, so the drop reverted it.
    expect(f.live()).toEqual({ moved: 10, unsaved: 42 });
    expect(f.counts().drops).toBe(1);
  });

  for (const mode of ["newer", "no-undo"] as const)
    test(`${mode}: refuse unsafe recovery without claiming rollback`, async () => {
      const f = server(mode),
        doc = await f.doc();
      let error: unknown;
      try {
        await doc.commit("edit", (tx) => tx.update([edit()]));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(CommitRecoveryError);
      expect((error as Error).message).toContain("Rollback could not be confirmed");
      expect((error as Error).message).toContain("Live document retained");
      expect((error as Error).message).not.toContain("Prior live state restored");
      expect(f.live()).toEqual({ moved: 25, unsaved: mode === "newer" ? 99 : 42 });
      expect(f.counts().undoCalls).toBe(0);
      expect(f.t.calls.some((c) => /SaveDocument|RevertDocument|CloseDocument/.test(c.typeName))).toBe(false);
    });
});
