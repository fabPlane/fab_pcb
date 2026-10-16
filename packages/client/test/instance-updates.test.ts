import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  BeginCommitResponseSchema,
  BeginCommitSchema,
  CommitAction,
  CreateItemsResponseSchema,
  CreateItemsSchema,
  DocumentSpecifierSchema,
  DocumentType,
  EndCommitResponseSchema,
  EndCommitSchema,
  GetItemsResponseSchema,
  GetItemsByIdSchema,
  ItemRequestStatus,
  ItemStatusCode,
  SchematicSymbolInstanceSchema,
  SchematicSymbolSchema,
  UpdateItemsResponseSchema,
  UpdateItemsSchema,
} from "@fp-pcb/proto";
import { KiCadClient } from "../src/client";
import { KiCad, SchematicSymbol, wrapAny } from "../src/model";
import { FakeTransport, reply } from "./fake-transport";

function fixture() {
  const t = new FakeTransport();
  const symbols = [1, 2, 3].map(
    (unit) =>
      new SchematicSymbol(
        create(SchematicSymbolInstanceSchema, {
          id: { value: `symbol-${unit}` },
          unit: { unit },
          libId: { libraryNickname: "Example", entryName: "Part" },
          referenceField: { name: "Reference", text: { text: "U9" } },
          valueField: { name: "Value", text: { text: "Part" } },
          definition: create(SchematicSymbolSchema, {
            id: { libraryNickname: "Example", entryName: "Part" },
            unitCount: 3,
          }),
        }),
      ),
  );
  t.on(GetItemsByIdSchema, (req) =>
    reply(GetItemsResponseSchema, {
      status: ItemRequestStatus.IRS_OK,
      items: symbols.filter((symbol) => req.items.some((id) => id.value === symbol.id)).map((symbol) => symbol.toAny()),
    }),
  );
  t.on(BeginCommitSchema, () => reply(BeginCommitResponseSchema, { id: { value: "edit" } }));
  t.on(EndCommitSchema, () => reply(EndCommitResponseSchema, {}));
  const updates: SchematicSymbol[][] = [];
  t.on(UpdateItemsSchema, (req) => {
    updates.push(req.items.map((any) => wrapAny(any) as SchematicSymbol));
    return reply(UpdateItemsResponseSchema, {
      status: ItemRequestStatus.IRS_OK,
      updatedItems: req.items.map((item) => ({ status: { code: ItemStatusCode.ISC_OK }, item })),
    });
  });
  const doc = async () =>
    new KiCad(await KiCadClient.connect(t, { clientName: "instance-test" })).schematicFrom(
      create(DocumentSpecifierSchema, {
        type: DocumentType.DOCTYPE_SCHEMATIC,
        identifier: { case: "boardFilename", value: "board.kicad_sch" },
      }),
    );
  return { t, symbols, updates, doc };
}

describe("placed-symbol instance updates", () => {
  for (const path of ["commit", "one-shot"] as const)
    test(`${path}: all units omit unchanged definitions and retain instance edits`, async () => {
      const f = fixture(),
        doc = await f.doc();
      const edited = f.symbols.map((symbol) => {
        const copy = symbol.clone();
        copy.position = { x: 25400000, y: 38100000 };
        copy.value = "Updated";
        return copy;
      });
      if (path === "commit") await doc.commit("move units", (tx) => tx.update(edited));
      else await doc.updateItems(edited.map((symbol) => symbol.proto));
      expect(f.updates).toHaveLength(1);
      expect(f.updates[0]).toHaveLength(3);
      for (const symbol of f.updates[0]!) {
        expect(symbol.proto.definition).toBeUndefined();
        expect(symbol.position).toEqual({ x: 25400000, y: 38100000 });
        expect(symbol.value).toBe("Updated");
      }
      expect(edited.every((symbol) => symbol.proto.definition)).toBe(true);
      expect(f.symbols.every((symbol) => symbol.value === "Part")).toBe(true);
    });

  for (const change of ["definition", "library"] as const)
    test(`rejects a ${change} change before sending UpdateItems`, async () => {
      const f = fixture(),
        doc = await f.doc(),
        symbol = f.symbols[0]!.clone();
      if (change === "definition") symbol.proto.definition!.unitCount = 4;
      else symbol.proto.libId!.entryName = "Other";
      await expect(doc.commit("unsafe definition", (tx) => tx.update([symbol]))).rejects.toThrow("replace the inspected symbol");
      expect(f.updates).toHaveLength(0);
      expect(
        f.t.calls.filter((c) => c.typeName === EndCommitSchema.typeName).map((c) => (c.request as { action: CommitAction }).action),
      ).toEqual([CommitAction.CMA_DROP]);
    });

  test("creation retains the complete library definition", async () => {
    const f = fixture(),
      doc = await f.doc();
    f.t.on(CreateItemsSchema, (req) => {
      expect((wrapAny(req.items[0]!) as SchematicSymbol).proto.definition?.unitCount).toBe(3);
      return reply(CreateItemsResponseSchema, {
        status: ItemRequestStatus.IRS_OK,
        createdItems: req.items.map((item) => ({ status: { code: ItemStatusCode.ISC_OK }, item })),
      });
    });
    await doc.commit("create units", (tx) => tx.create(f.symbols));
  });
});
