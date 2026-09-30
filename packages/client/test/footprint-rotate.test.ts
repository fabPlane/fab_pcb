import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { BoardGraphicShapeSchema, BoardLayer, FieldSchema, FootprintInstanceSchema, PadSchema, packAny } from "@fp-pcb/proto";
import { Footprint, BoardShape } from "../src/model";
const point = (x: number, y: number) => ({ xNm: BigInt(x), yNm: BigInt(y) });
function fixture() {
  return new Footprint(
    create(FootprintInstanceSchema, {
      id: { value: "connector" },
      position: point(100, 200),
      orientation: { valueDegrees: -90 },
      layer: BoardLayer.BL_F_Cu,
      referenceField: create(FieldSchema, {
        text: { text: { text: "J13", position: point(110, 200), attributes: { angle: { valueDegrees: -90 } } } },
      }),
      definition: {
        id: { libraryNickname: "Missing", entryName: "Embedded" },
        items: [
          packAny(
            PadSchema,
            create(PadSchema, {
              id: { value: "pad" },
              number: "1",
              position: point(110, 220),
              net: { name: "GND", code: { value: 1 } },
              padStack: { angle: { valueDegrees: -90 }, copperLayers: [{ size: point(30, 80) }] },
            }),
          ),
          packAny(
            BoardGraphicShapeSchema,
            create(BoardGraphicShapeSchema, {
              id: { value: "outline" },
              shape: { geometry: { case: "arc", value: { start: point(110, 200), mid: point(110, 210), end: point(100, 210) } } },
            }),
          ),
        ],
      },
    }),
  );
}
describe("Footprint.rotate", () => {
  test("180 degrees moves pad centers, angles, fields and arc geometry around the anchor", () => {
    const f = fixture();
    expect(f.rotate(180)).toBe(f);
    expect(f.orientation).toBe(90);
    expect(f.position).toEqual({ x: 100, y: 200 });
    expect(f.referenceField?.position).toEqual({ x: 90, y: 200 });
    expect(f.pads[0]?.position).toEqual({ x: 90, y: 180 });
    expect(f.pads[0]?.orientation).toBe(90);
    expect(f.pads[0]?.id).toBe("pad");
    expect(f.pads[0]?.net).toBe("GND");
    expect(f.pads[0]?.size).toEqual({ x: 30, y: 80 });
    expect(f.libraryId).toBe("Missing:Embedded");
    expect((f.items[1] as BoardShape).start).toEqual({ x: 90, y: 200 });
    expect((f.items[1] as BoardShape).proto.shape?.geometry).toMatchObject({ case: "arc", value: { mid: point(90, 190) } });
  });
  test("positive angles rotate counterclockwise with Y down", () => {
    const f = fixture().rotate(90);
    expect(f.pads[0]?.position).toEqual({ x: 120, y: 190 });
    expect(f.pads[0]?.orientation).toBe(0);
  });
  test("arbitrary rotations round only coordinates, and inverse rotation restores them", () => {
    const f = fixture().rotate(30);
    expect(f.pads[0]?.position).toEqual({ x: 119, y: 212 });
    f.rotate(-30);
    expect(f.pads[0]?.position).toEqual({ x: 110, y: 220 });
  });
  test("equivalent angles do not mutate the snapshot", () => {
    const f = fixture();
    const original = f.clone();
    f.rotate(360);
    expect(f.equals(original)).toBe(true);
  });
  test("unknown embedded items fail without a partial rotation", () => {
    const f = fixture();
    f.proto.definition!.items.push({
      $typeName: "google.protobuf.Any",
      typeUrl: "type.googleapis.com/unknown.Child",
      value: new Uint8Array(),
    });
    const original = f.clone();
    expect(() => f.rotate(180)).toThrow("unknown footprint child");
    expect(f.equals(original)).toBe(true);
  });
});
